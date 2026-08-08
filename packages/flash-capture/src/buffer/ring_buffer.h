#pragma once

#include "../encoding/encoder.h"
#include <vector>
#include <mutex>
#include <cstdint>

namespace flash {

// Circular buffer that holds the last N seconds of encoded video packets.
// When full, oldest packets are overwritten.
// On clip save, the entire buffer is flushed to a file.
class RingBuffer {
public:
    explicit RingBuffer(uint32_t maxDurationSeconds = 30, uint32_t fps = 60);
    ~RingBuffer();

    // Push an encoded packet into the buffer
    void Push(const EncodedPacket& packet);

    // Flush all buffered packets (for clip save)
    // Returns packets in chronological order
    std::vector<EncodedPacket> Flush();

    // Get current buffer duration in seconds
    float GetDurationSeconds() const;

    // Get number of packets in buffer
    size_t GetPacketCount() const;

    // Clear buffer
    void Clear();

    // Reconfigure buffer size
    void SetMaxDuration(uint32_t seconds, uint32_t fps);

private:
    mutable std::mutex mutex_;
    std::vector<EncodedPacket> packets_;
    size_t writePos_ = 0;
    size_t count_ = 0;
    size_t capacity_ = 0;
    uint32_t maxDurationSeconds_;
    uint32_t fps_;
};

} // namespace flash
