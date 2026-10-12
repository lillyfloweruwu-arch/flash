// Self-check for the mixer that turns several apps' audio into one continuous
// track. Pure logic with explicit clocks, so every case is deterministic.
#include "../src/core/lane_mixer.h"
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <limits>

using namespace flash;

static std::vector<float> Tone(uint32_t frames, float value) {
    return std::vector<float>(static_cast<size_t>(frames) * LaneMixer::kChannels, value);
}
static bool Near(float a, float b) { return std::fabs(a - b) < 1e-6f; }
// Microseconds at which `frames` frames have elapsed.
static int64_t Us(int64_t frames) { return frames * 1000000 / LaneMixer::kRate; }

int main() {
    const int64_t hold = Us(LaneMixer::kHoldFrames);   // 30000

    // Two apps on one lane are summed.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f), b = Tone(480, 0.5f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(2, b.data(), 480, 0);
        mixer.Pull(Us(480) + hold, out);
        assert(out.size() == 1 && out[0].startUs == 0);
        assert(out[0].samples.size() == 960);
        for (float s : out[0].samples) assert(Near(s, 0.75f));
    }

    // The sum is limited to full scale, never wrapped.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.8f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(2, a.data(), 480, 0);
        mixer.Pull(Us(480) + hold, out);
        assert(out.size() == 1);
        for (float s : out[0].samples) assert(Near(s, 1.0f));
    }

    // An app that starts 5 ms late leaves silence before it, exactly.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f), b = Tone(480, 0.5f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(2, b.data(), 480, Us(240));
        mixer.Pull(Us(960) + hold, out);
        assert(out.size() == 2);
        assert(Near(out[0].samples[0], 0.25f) && Near(out[0].samples[239 * 2], 0.25f));
        assert(Near(out[0].samples[240 * 2], 0.75f) && Near(out[0].samples[479 * 2 + 1], 0.75f));
        assert(out[1].startUs == Us(480));
        assert(Near(out[1].samples[0], 0.5f) && Near(out[1].samples[239 * 2], 0.5f));
        assert(Near(out[1].samples[240 * 2], 0.0f) && Near(out[1].samples[479 * 2], 0.0f));
    }

    // A gap in one app is silence, not a repeat and not a shift: the audio
    // after the gap lands where its timestamp says.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(1, a.data(), 480, Us(1920));
        mixer.Pull(Us(2400) + hold, out);
        assert(out.size() == 2);                       // the three silent stretches are not emitted
        assert(out[0].startUs == 0 && out[1].startUs == Us(1920));
        for (float s : out[1].samples) assert(Near(s, 0.25f));
    }
    // Same thing when the mixer drained in between.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Pull(Us(960) + hold, out);
        mixer.Push(1, a.data(), 480, Us(1920));
        mixer.Pull(Us(2400) + hold, out);
        assert(out.size() == 2 && out[1].startUs == Us(1920));
    }

    // Output is exactly 10 ms packets, contiguous and in order. Packets pushed
    // back to back are joined by counting samples, not by their timestamps:
    // the second one below claims to start 3 ms early and must not overlap.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(2400, 0.1f);
        mixer.Push(1, a.data(), 2400, 0);
        mixer.Push(1, a.data(), 2400, Us(2400) - 3000);
        mixer.Pull(Us(4800) + hold, out);
        assert(out.size() == 10);
        for (size_t i = 0; i < out.size(); ++i) {
            assert(out[i].samples.size() == 960);
            assert(out[i].startUs == static_cast<int64_t>(i) * 10000);
            for (float s : out[i].samples) assert(Near(s, 0.1f));
        }
    }

    // An app whose audio piles up (a faster clock) loses its oldest audio and
    // keeps its newest.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        std::vector<float> ramp(12000 * 2);
        for (size_t i = 0; i < 12000; ++i) ramp[i * 2] = ramp[i * 2 + 1] = static_cast<float>(i + 1) / 12000.0f;
        mixer.Push(1, ramp.data(), 12000, 0);
        mixer.Pull(Us(14400), out);
        // 12000 buffered is over the limit, so all but the last 1440 frames go.
        assert(out.size() == 3);
        assert(out[0].startUs == Us(10560));
        assert(Near(out[0].samples[0], 10561.0f / 12000.0f));
        assert(Near(out[2].samples[479 * 2], 1.0f));
    }

    // No apps: nothing is emitted, and the timeline still moves, so the first
    // real packet afterwards is stamped with its own time.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        mixer.Pull(Us(4800), out);
        assert(out.empty());
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, Us(4800));
        mixer.Pull(Us(5280) + hold, out);
        assert(out.size() == 1 && out[0].startUs == Us(4800));
    }

    // Audio that arrives for a moment already written is trimmed, not shifted.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        mixer.Pull(Us(3360) + hold, out);              // everything up to frame 3360 is settled
        const auto a = Tone(480, 0.5f);
        mixer.Push(2, a.data(), 480, Us(3120));        // its first 240 frames are in the past
        mixer.Pull(Us(3840) + hold, out);
        assert(out.size() == 1 && out[0].startUs == Us(3360));
        assert(Near(out[0].samples[0], 0.5f) && Near(out[0].samples[239 * 2], 0.5f));
        assert(Near(out[0].samples[240 * 2], 0.0f));
    }

    // A removed app contributes nothing further.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Remove(1);
        mixer.Pull(Us(480) + hold, out);
        assert(out.empty());
        mixer.Remove(42);                              // unknown source is fine
    }

    // Bad input is ignored.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);                            // fixes the origin at time 0
        mixer.Push(1, nullptr, 480, 0);
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 0, 0);
        mixer.Pull(Us(960) + hold, out);
        assert(out.empty());
        // ...and the mixer is still usable afterwards.
        mixer.Push(1, a.data(), 480, Us(960));
        mixer.Pull(Us(1440) + hold, out);
        assert(out.size() == 1 && out[0].startUs == Us(960));
        for (float s : out[0].samples) assert(Near(s, 0.25f));
    }

    // A driver's NaN or infinity becomes silence, not a full-scale click.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        auto a = Tone(480, 0.25f);
        a[10] = std::numeric_limits<float>::quiet_NaN();
        a[11] = std::numeric_limits<float>::infinity();
        a[20] = -std::numeric_limits<float>::infinity();
        mixer.Push(1, a.data(), 480, 0);
        mixer.Pull(Us(480) + hold, out);
        assert(out.size() == 1);
        for (size_t i = 0; i < out[0].samples.size(); ++i) {
            const bool bad = (i == 10 || i == 11 || i == 20);
            assert(Near(out[0].samples[i], bad ? 0.0f : 0.25f));
        }
    }

    // A wildly wrong timestamp is dropped, and the mixer carries on.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, std::numeric_limits<int64_t>::max() / 2);   // first packet of a source
        mixer.Push(1, a.data(), 480, std::numeric_limits<int64_t>::min() / 2);   // far in the past
        mixer.Push(1, a.data(), 480, std::numeric_limits<int64_t>::max());
        mixer.Pull(Us(480) + hold, out);
        assert(out.empty());
        mixer.Push(1, a.data(), 480, Us(480));
        mixer.Pull(Us(960) + hold, out);
        assert(out.size() == 1 && out[0].startUs == Us(480));
        for (float s : out[0].samples) assert(Near(s, 0.25f));
    }
    // Same for the jump-ahead branch of a source that already has audio waiting.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(1, a.data(), 480, std::numeric_limits<int64_t>::max() / 2);
        mixer.Pull(Us(480) + hold, out);
        assert(out.size() == 1 && out[0].startUs == 0);
        for (float s : out[0].samples) assert(Near(s, 0.25f));
    }

    // A source 10 s ahead is reached in one step and stamped correctly.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, Us(480000));
        mixer.Pull(Us(480000 + 480) + hold, out);
        assert(out.size() == 1 && out[0].startUs == Us(480000));
        for (float s : out[0].samples) assert(Near(s, 0.25f));
    }

    // A huge clock jump with nothing buffered (sleep, a debugger pause) is
    // crossed in one step, not walked 10 ms at a time.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        const int64_t later = 1000LL * 3600 * 1000000;          // one thousand hours, on a 10 ms boundary
        const auto begin = std::chrono::steady_clock::now();
        mixer.Pull(later, out);
        const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - begin).count();
        assert(out.empty());
        assert(seconds < 2.0);
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, later);
        mixer.Pull(later + 40000, out);
        assert(out.size() == 1 && out[0].startUs == later);
        for (float s : out[0].samples) assert(Near(s, 0.25f));
    }

    // Wild timestamps, on an empty source and on one with audio waiting. Each
    // bad packet is dropped (it is neither placed far away nor laid end to end
    // as if real), only the legitimate audio comes out, and the mixer carries on.
    {
        const int64_t wild[] = {std::numeric_limits<int64_t>::max() / 2, std::numeric_limits<int64_t>::min() / 2,
                                std::numeric_limits<int64_t>::max(), std::numeric_limits<int64_t>::min()};
        const auto a = Tone(480, 0.25f);
        for (int64_t stamp : wild) {
            for (int waiting = 0; waiting < 2; ++waiting) {
                LaneMixer mixer; std::vector<LaneMixer::Packet> out;
                mixer.Pull(0, out);
                if (waiting) mixer.Push(1, a.data(), 480, 0);
                mixer.Push(1, a.data(), 480, stamp);
                mixer.Pull(Us(4800) + hold, out);          // several packets past anything buffered
                if (waiting) {
                    assert(out.size() == 1 && out[0].startUs == 0);
                    for (float s : out[0].samples) assert(Near(s, 0.25f));
                } else {
                    assert(out.empty());
                }
                out.clear();
                mixer.Push(1, a.data(), 480, Us(4800));    // still works normally
                mixer.Pull(Us(5280) + hold, out);
                assert(out.size() == 1 && out[0].startUs == Us(4800));
                for (float s : out[0].samples) assert(Near(s, 0.25f));
            }
        }
    }

    // An absurd clock reading passed to Pull is ignored: nothing is emitted and
    // the timeline does not move, on a fresh mixer and on a running one.
    {
        const int64_t extremes[] = {std::numeric_limits<int64_t>::max(), std::numeric_limits<int64_t>::min()};
        for (int64_t now : extremes) {
            LaneMixer fresh; std::vector<LaneMixer::Packet> out;
            fresh.Pull(now, out);                          // the first reading only sets the origin
            fresh.Pull(now, out);
            assert(out.empty());

            LaneMixer running;
            running.Pull(0, out);
            const auto a = Tone(480, 0.25f);
            running.Push(1, a.data(), 480, 0);
            running.Pull(now, out);
            assert(out.empty());
            running.Pull(Us(480) + hold, out);             // unaffected by the ignored readings
            assert(out.size() == 1 && out[0].startUs == 0);
            for (float s : out[0].samples) assert(Near(s, 0.25f));
        }
    }

    std::puts("lane mixer self-check passed");
    return 0;
}
