#include "ring_buffer.h"
#include <algorithm>

namespace flash {

RingBuffer::RingBuffer(uint32_t maxDurationSeconds, uint32_t fps)
    : maxDurationSeconds_(maxDurationSeconds), fps_(fps) {
    capacity_ = maxDurationSeconds * fps;
    packets_.resize(capacity_);
}

RingBuffer::~RingBuffer() = default;

void RingBuffer::Push(const EncodedPacket& packet) {
    std::lock_guard<std::mutex> lock(mutex_);

    packets_[writePos_] = packet;
    writePos_ = (writePos_ + 1) % capacity_;
    if (count_ < capacity_) {
        count_++;
    }
}

std::vector<EncodedPacket> RingBuffer::Flush() {
    std::lock_guard<std::mutex> lock(mutex_);

    std::vector<EncodedPacket> result;
    result.reserve(count_);

    if (count_ < capacity_) {
        // Buffer hasn't wrapped yet — packets are in order from 0 to count_
        for (size_t i = 0; i < count_; i++) {
            result.push_back(std::move(packets_[i]));
        }
    } else {
        // Buffer has wrapped — oldest packet is at writePos_
        for (size_t i = 0; i < capacity_; i++) {
            size_t idx = (writePos_ + i) % capacity_;
            result.push_back(std::move(packets_[idx]));
        }
    }

    // Find the nearest keyframe to start from (ensures valid playback)
    size_t startIdx = 0;
    for (size_t i = 0; i < result.size(); i++) {
        if (result[i].isKeyframe) {
            startIdx = i;
            break;
        }
    }

    if (startIdx > 0) {
        result.erase(result.begin(), result.begin() + startIdx);
    }

    // Reset buffer
    count_ = 0;
    writePos_ = 0;

    return result;
}

float RingBuffer::GetDurationSeconds() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (count_ == 0 || fps_ == 0) return 0.0f;
    return static_cast<float>(count_) / static_cast<float>(fps_);
}

size_t RingBuffer::GetPacketCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return count_;
}

void RingBuffer::Clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    count_ = 0;
    writePos_ = 0;
}

void RingBuffer::SetMaxDuration(uint32_t seconds, uint32_t fps) {
    std::lock_guard<std::mutex> lock(mutex_);
    maxDurationSeconds_ = seconds;
    fps_ = fps;
    capacity_ = seconds * fps;
    packets_.clear();
    packets_.resize(capacity_);
    count_ = 0;
    writePos_ = 0;
}

} // namespace flash
