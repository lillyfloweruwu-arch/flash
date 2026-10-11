#pragma once

#include "video_source.h"
#include <memory>
#include <cstdint>
#include <vector>
#include <string>

namespace flash {

struct EncodedPacket {
    std::vector<uint8_t> data;
    int64_t pts_us = 0;
    bool isKeyframe = false;
    int64_t dts_us = 0;
    int64_t duration_us = 0;
};

struct EncoderConfig {
    uint32_t width = 1920;
    uint32_t height = 1080;
    uint32_t fps = 60;
    uint32_t bitrate = 20000000; // 20 Mbps
    std::string preset = "fast";  // fast/medium/slow
    // Linux file exports only. The capture path leaves both at their defaults.
    std::string codec = "h264";   // "h264" or "av1"
    bool exportQuality = false;   // quality over latency: lookahead, VBR with a peak, longer GOP
    bool highProfile = false;   // request H.264 High on hardware encoders (file exports)
    void* device = nullptr;
};

// Abstract encoder interface — NVENC, AMF, and software all implement this
class VideoEncoder {
public:
    virtual ~VideoEncoder() = default;

    virtual bool Initialize(const EncoderConfig& config) = 0;
    virtual bool EncodeFrame(const FrameData& frame, std::vector<EncodedPacket>& output) = 0;
    virtual void Flush() = 0;
    // File exports must collect delayed packets before destroying the encoder.
    virtual bool Drain(std::vector<EncodedPacket>&) { return true; }
    virtual std::string GetName() const = 0;
    virtual bool IsHardwareAccelerated() const = 0;
};

using Encoder = VideoEncoder;

enum class GpuVendor {
    Unknown,
    Nvidia,
    Amd,
    Intel
};

// Detect GPU vendor
GpuVendor DetectGpuVendor();

// Create best available encoder
std::unique_ptr<Encoder> CreateEncoder();
std::unique_ptr<Encoder> CreateEncoder(const EncoderConfig& config);

} // namespace flash
