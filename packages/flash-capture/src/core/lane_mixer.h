#pragma once
#include <algorithm>
#include <cstdint>
#include <deque>
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
    static constexpr int64_t kHoldFrames = 1440;          // 30 ms
    // A source that has this much waiting is running ahead of the clock (its
    // device is faster, or the mixer stalled). It is cut back to the hold.
    static constexpr int64_t kMaxBufferedFrames = 11040;  // 230 ms
    static constexpr int64_t kGapFrames = 960;            // 20 ms

    struct Packet {
        std::vector<float> samples;   // kPacketFrames interleaved stereo frames
        int64_t startUs = 0;
    };

    void Push(uint64_t source, const float* samples, uint32_t frames, int64_t startUs) {
        if (!samples || !frames) return;
        if (!started_) { originUs_ = startUs; started_ = true; }
        int64_t position = FrameAt(startUs);
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
        s.samples.insert(s.samples.end(), samples + static_cast<size_t>(skip) * kChannels,
                         samples + static_cast<size_t>(frames) * kChannels);
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
        const int64_t ready = FrameAt(nowUs) - kHoldFrames;
        while (emitted_ + kPacketFrames <= ready) {
            Packet packet;
            packet.samples.assign(static_cast<size_t>(kPacketFrames) * kChannels, 0.0f);
            packet.startUs = originUs_ + emitted_ * 1000000 / kRate;
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
    static int64_t Buffered(const Source& s) { return static_cast<int64_t>(s.samples.size() / kChannels); }
    int64_t FrameAt(int64_t timeUs) const { return (timeUs - originUs_) * kRate / 1000000; }

    std::map<uint64_t, Source> sources_;
    int64_t originUs_ = 0, emitted_ = 0;
    bool started_ = false;
};

} // namespace flash
