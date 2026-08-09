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
    if (count_ == 0 || capacity_ == 0) return {};

    // Copy, never move: a replay buffer keeps its history. Draining here makes a
    // second hotkey press inside the buffer window return an empty clip.
    // ponytail: copies the whole window (~75 MB at 30 s / 20 Mbps) under the lock;
    // hand out shared_ptr<const EncodedPacket> if the hitch ever shows up.
    std::vector<EncodedPacket> result;
    result.reserve(count_);
    const size_t oldest = (count_ < capacity_) ? 0 : writePos_;
    for (size_t i = 0; i < count_; i++) {
        result.push_back(packets_[(oldest + i) % capacity_]);
    }

    // The ring is sized in frames, but DXGI only delivers a frame when the screen
    // changes — on a static screen count_/fps_ spans far more than the requested
    // seconds. Trim by timestamp so the clip is the length the user asked for.
    const int64_t cutoff = result.back().timestamp_us -
        static_cast<int64_t>(maxDurationSeconds_) * 1000000;
    size_t start = 0;
    while (start < result.size() && result[start].timestamp_us < cutoff) start++;

    // H.264 cannot decode from a P-frame. Back up to the keyframe covering the
    // window start; if there is none before it, skip forward to the first one.
    size_t key = start;
    while (key > 0 && !result[key].isKeyframe) key--;
    if (!result[key].isKeyframe) {
        key = start;
        while (key < result.size() && !result[key].isKeyframe) key++;
        if (key >= result.size()) return {};
    }

    result.erase(result.begin(), result.begin() + key);
    return result;
}

float RingBuffer::GetDurationSeconds() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (count_ < 2 || capacity_ == 0) return 0.0f;
    const size_t oldest = count_ < capacity_ ? 0 : writePos_;
    const size_t newest = (writePos_ + capacity_ - 1) % capacity_;
    return static_cast<float>((std::max<int64_t>)(0, packets_[newest].timestamp_us - packets_[oldest].timestamp_us)) / 1000000.0f;
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
