// Self-check for the mixer that turns several apps' audio into one continuous
// track. Pure logic with explicit clocks, so every case is deterministic.
#include "../src/core/lane_mixer.h"
#include <cassert>
#include <cmath>
#include <cstdio>

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
        mixer.Push(1, nullptr, 480, 0);
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 0, 0);
        mixer.Pull(Us(960) + hold, out);
        assert(out.empty());
    }

    std::puts("lane mixer self-check passed");
    return 0;
}
