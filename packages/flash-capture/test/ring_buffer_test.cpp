// Self-check for the replay buffer. Build and run with:
//   cmake --build build --target flash_ring_buffer_test && build/Release/flash_ring_buffer_test
#include "../src/buffer/ring_buffer.h"
#include <cassert>
#include <cstdio>

using namespace flash;

namespace {

constexpr uint32_t kFps = 60;
constexpr uint32_t kSeconds = 5;
constexpr uint32_t kGop = kFps * 2;

// One packet per frame at a steady 60 fps, keyframe every 2 seconds.
void PushFrames(RingBuffer& buffer, uint32_t count, int64_t startUs = 0) {
    for (uint32_t i = 0; i < count; i++) {
        EncodedPacket packet;
        packet.data.assign(16, static_cast<uint8_t>(i));
        packet.timestamp_us = startUs + static_cast<int64_t>(i) * (1000000 / kFps);
        packet.isKeyframe = (i % kGop) == 0;
        buffer.Push(packet);
    }
}

} // namespace

int main() {
    // Flushing must not drain: the second hotkey press has to get a clip too.
    {
        RingBuffer buffer(kSeconds, kFps);
        PushFrames(buffer, kSeconds * kFps);
        const auto first = buffer.Flush();
        assert(!first.empty());
        assert(first.front().isKeyframe);
        const auto second = buffer.Flush();
        assert(second.size() == first.size());
        assert(buffer.GetPacketCount() == kSeconds * kFps);
    }

    // A wrapped buffer returns packets oldest-first, starting on a keyframe.
    {
        RingBuffer buffer(kSeconds, kFps);
        PushFrames(buffer, kSeconds * kFps * 3);
        const auto clip = buffer.Flush();
        assert(clip.front().isKeyframe);
        for (size_t i = 1; i < clip.size(); i++)
            assert(clip[i].timestamp_us > clip[i - 1].timestamp_us);
    }

    // A static screen produces few frames spread over a long time. Trimming is by
    // timestamp, so a 5 s window must not hand back 40 s of stills.
    {
        RingBuffer buffer(kSeconds, kFps);
        for (uint32_t i = 0; i < 40; i++) {
            EncodedPacket packet;
            packet.data.assign(16, 0);
            packet.timestamp_us = static_cast<int64_t>(i) * 1000000; // 1 fps
            packet.isKeyframe = true;
            buffer.Push(packet);
        }
        const auto clip = buffer.Flush();
        const int64_t span = clip.back().timestamp_us - clip.front().timestamp_us;
        assert(span <= static_cast<int64_t>(kSeconds) * 1000000);
        assert(clip.size() > 1);
    }

    // Nothing captured yet is not an error, just an empty clip.
    {
        RingBuffer buffer(kSeconds, kFps);
        assert(buffer.Flush().empty());
    }

    // A requested save window retains the whole trailing span and starts at the
    // preceding keyframe so the result is decodable. The real guarantee is not
    // an exact duration: keyframe walk-back can add almost one GOP. Here the
    // 4 s cutoff lands in the GOP starting near 4 s, producing a near-6 s clip.
    {
        RingBuffer buffer(10, kFps);
        PushFrames(buffer, 10 * kFps);
        const auto clip = buffer.Flush(4.0);
        const int64_t span = clip.back().timestamp_us - clip.front().timestamp_us;
        assert(clip.front().isKeyframe);
        assert(span > 5900000 && span < 6100000);
    }

    // Status duration follows timestamps, not the configured/previous frame rate.
    {
        RingBuffer buffer(10, 60);
        for (int i = 0; i < 6; ++i) {
            EncodedPacket packet; packet.timestamp_us = i * 200000; packet.isKeyframe = true; buffer.Push(packet);
        }
        assert(buffer.GetDurationSeconds() > 0.99f && buffer.GetDurationSeconds() < 1.01f);
    }

    // Re-applying the same length must not clear the replay (the app does it on
    // every game change), and changing it keeps the newest history that fits.
    {
        RingBuffer buffer(kSeconds, kFps);
        PushFrames(buffer, kSeconds * kFps);
        buffer.SetMaxDuration(kSeconds, kFps);
        assert(buffer.GetPacketCount() == kSeconds * kFps);

        const auto before = buffer.Flush();
        buffer.SetMaxDuration(kSeconds * 2, kFps);
        assert(buffer.GetPacketCount() == kSeconds * kFps);
        const auto grown = buffer.Flush();
        assert(grown.size() == before.size());
        assert(grown.back().timestamp_us == before.back().timestamp_us);

        buffer.SetMaxDuration(2, kFps);
        assert(buffer.GetPacketCount() == 2 * kFps);
        PushFrames(buffer, 10, before.back().timestamp_us + 1000000 / kFps);
        assert(buffer.GetPacketCount() == 2 * kFps);
        const auto shrunk = buffer.Flush();
        for (size_t i = 1; i < shrunk.size(); i++)
            assert(shrunk[i].timestamp_us > shrunk[i - 1].timestamp_us);
    }

    std::puts("ring_buffer: ok");
    return 0;
}
