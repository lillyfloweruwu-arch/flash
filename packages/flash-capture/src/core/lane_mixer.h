#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <limits>
#include <map>
#include <vector>

namespace flash {

// Turns the audio of several apps into one continuous track.
//
// The clip writer wants a single stream of packets per track. Two apps feeding
// one lane would hand it overlapping packets, so each lane has one of these:
// apps push what they captured, stamped with the capture clock, and the lane
// pulls fixed 10 ms packets holding the sum.
//
// Time is counted in samples. A source's first packet is placed by its
// timestamp; everything it pushes after that is laid end to end, because
// capture timestamps are taken when a packet is drained, and under load several
// drain at once and claim nearly the same instant. Only a real pause (more than
// kGapFrames) is trusted as a gap. Output packets are stamped from the count of
// samples already emitted, so they are contiguous by construction.
//
// Not thread-safe: the owner serialises Push, Remove and Pull.
class LaneMixer {
public:
    static constexpr uint32_t kRate = 48000, kChannels = 2, kPacketFrames = 480;
    // Output trails the clock by this much, so a packet that is drained a
    // little late still lands in place.
    static constexpr int64_t kHoldFrames = 3840;          // 80 ms
    // A source that has this much waiting is running ahead of the clock (its
    // device is faster, or the mixer stalled). It is cut back to the hold.
    static constexpr int64_t kMaxBufferedFrames = 14400;  // 300 ms
    static constexpr int64_t kGapFrames = 960;            // 20 ms

    struct Packet {
        std::vector<float> samples;   // kPacketFrames interleaved stereo frames
        int64_t startUs = 0;
    };

    void Push(uint64_t source, const float* samples, uint32_t frames, int64_t startUs) {
        if (!samples || !frames) return;
        if (!started_) { originUs_ = startUs; started_ = true; }
        // Decide from the microsecond difference, before any conversion to
        // frames, so no timestamp can overflow the arithmetic. A packet too far
        // ahead of, or behind, the point already emitted is a bad clock: dropped,
        // whether or not the source has audio waiting.
        const int64_t relUs = SaturatedSub(SaturatedSub(startUs, originUs_), FramesToUs(emitted_));
        if (relUs > kMaxAheadUs || relUs < -kMaxPastUs) return;
        int64_t position = emitted_ + relUs * kRate / 1000000;   // |relUs| <= 5 minutes: cannot overflow
        Source& s = sources_[source];
        const int64_t buffered = Buffered(s);
        uint32_t skip = 0;
        if (!buffered) {
            // Starting, or resuming after running dry: trust the timestamp,
            // but never write into time that has already been emitted.
            if (position < emitted_) {
                skip = static_cast<uint32_t>((std::min)(static_cast<int64_t>(frames), emitted_ - position));
                position = emitted_;
            }
            s.front = position;
        } else {
            const int64_t gap = position - (s.front + buffered);
            if (gap > kMaxBufferedFrames) {
                s.samples.clear();
                s.front = position;
            } else if (gap > kGapFrames) {
                s.samples.insert(s.samples.end(), static_cast<size_t>(gap) * kChannels, 0.0f);
            }
        }
        // A driver's NaN or infinity must not become a full-scale click.
        for (const float* p = samples + static_cast<size_t>(skip) * kChannels,
                        * end = samples + static_cast<size_t>(frames) * kChannels; p != end; ++p)
            s.samples.push_back(std::isfinite(*p) ? *p : 0.0f);
        const int64_t waiting = Buffered(s);
        if (waiting > kMaxBufferedFrames) {
            const int64_t drop = waiting - kHoldFrames;
            s.samples.erase(s.samples.begin(), s.samples.begin() + static_cast<std::ptrdiff_t>(drop * kChannels));
            s.front += drop;
        }
    }

    void Remove(uint64_t source) { sources_.erase(source); }

    // Appends every packet that is complete as of nowUs. Stretches in which no
    // source had any sound are skipped: the timeline advances, nothing is
    // emitted, and the clip writer fills the silence.
    void Pull(int64_t nowUs, std::vector<Packet>& out) {
        if (!started_) { originUs_ = nowUs; started_ = true; }
        // An absurd clock reading (anything over ~1 year from the origin) is
        // ignored: nothing is emitted and the timeline does not move.
        const int64_t sinceOriginUs = SaturatedSub(nowUs, originUs_);
        if (sinceOriginUs > kMaxTimelineUs || sinceOriginUs < -kMaxTimelineUs) return;
        const int64_t ready = sinceOriginUs * kRate / 1000000 - kHoldFrames;
        while (emitted_ + kPacketFrames <= ready) {
            // Time no source covers is crossed in one step, by whole packets,
            // however long it is: after a sleep or a debugger pause it can be
            // hours, and the owner is holding its lock.
            bool anyAudio = false;
            int64_t earliest = 0;
            for (const auto& entry : sources_) {
                const Source& s = entry.second;
                if (!Buffered(s)) continue;
                earliest = anyAudio ? (std::min)(earliest, s.front) : s.front;
                anyAudio = true;
            }
            if (!anyAudio || earliest >= emitted_ + kPacketFrames) {
                const int64_t target = anyAudio ? (std::min)(ready, earliest) : ready;
                emitted_ += (target - emitted_) / kPacketFrames * kPacketFrames;
                continue;
            }
            Packet packet;
            packet.samples.assign(static_cast<size_t>(kPacketFrames) * kChannels, 0.0f);
            packet.startUs = SaturatedAdd(originUs_, FramesToUs(emitted_));
            const int64_t end = emitted_ + kPacketFrames;
            bool audible = false;
            for (auto& entry : sources_) {
                Source& s = entry.second;
                const int64_t buffered = Buffered(s);
                if (!buffered || s.front >= end) continue;
                const int64_t to = (std::min)(s.front + buffered, end);
                for (int64_t frame = s.front; frame < to; ++frame) {
                    for (uint32_t c = 0; c < kChannels; ++c) {
                        const float value = s.samples[static_cast<size_t>(frame - s.front) * kChannels + c];
                        if (value != 0.0f) audible = true;
                        packet.samples[static_cast<size_t>(frame - emitted_) * kChannels + c] += value;
                    }
                }
                s.samples.erase(s.samples.begin(),
                                s.samples.begin() + static_cast<std::ptrdiff_t>((to - s.front) * kChannels));
                s.front = to;
            }
            emitted_ = end;
            if (!audible) continue;
            for (float& sample : packet.samples) sample = (std::max)(-1.0f, (std::min)(1.0f, sample));
            out.push_back(std::move(packet));
        }
    }

private:
    struct Source {
        std::deque<float> samples;   // interleaved, starting at frame `front`
        int64_t front = 0;           // frames since the origin
    };
    // A packet stamped further ahead than this is a bad clock, not audio.
    static constexpr int64_t kMaxAheadUs = 60 * 1000000;
    // A packet stamped further behind the emitted point than this is also bad.
    static constexpr int64_t kMaxPastUs = 300 * 1000000;
    // Pull ignores a clock reading further than this from the origin (~1 year;
    // times kRate it still fits an int64_t with room to spare).
    static constexpr int64_t kMaxTimelineUs = int64_t(1) << 45;
    static int64_t SaturatedAdd(int64_t a, int64_t b) {
        if (b > 0 && a > (std::numeric_limits<int64_t>::max)() - b) return (std::numeric_limits<int64_t>::max)();
        if (b < 0 && a < (std::numeric_limits<int64_t>::min)() - b) return (std::numeric_limits<int64_t>::min)();
        return a + b;
    }
    // Exact, and safe for any frame count that fits the timeline.
    static int64_t FramesToUs(int64_t frames) {
        return frames / kRate * 1000000 + frames % kRate * 1000000 / kRate;
    }
    static int64_t SaturatedSub(int64_t a, int64_t b) {
        if (b < 0 && a > (std::numeric_limits<int64_t>::max)() + b) return (std::numeric_limits<int64_t>::max)();
        if (b > 0 && a < (std::numeric_limits<int64_t>::min)() + b) return (std::numeric_limits<int64_t>::min)();
        return a - b;
    }
    static int64_t Buffered(const Source& s) { return static_cast<int64_t>(s.samples.size() / kChannels); }

    std::map<uint64_t, Source> sources_;
    int64_t originUs_ = 0, emitted_ = 0;
    bool started_ = false;
};

} // namespace flash
