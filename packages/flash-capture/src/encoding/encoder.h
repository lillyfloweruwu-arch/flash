#pragma once

#include "../capture/screen_capture.h"
#include <cstdint>
#include <vector>
#include <string>

namespace flash {

struct EncodedPacket {
    std::vector<uint8_t> data;
    int64_t timestamp_us;
    bool isKeyframe;
};

struct EncoderConfig {
    uint32_t width = 1920;
    uint32_t height = 1080;
    uint32_t fps = 60;
    uint32_t bitrate = 20000000; // 20 Mbps
    std::string preset = "fast";  // fast/medium/slow
};

// Abstract encoder interface — NVENC, AMF, and software all implement this
class Encoder {
public:
    virtual ~Encoder() = default;

    virtual bool Initialize(const EncoderConfig& config) = 0;
    virtual bool EncodeFrame(const FrameData& frame, EncodedPacket& output) = 0;
    virtual void Flush() = 0;
    virtual std::string GetName() const = 0;
    virtual bool IsHardwareAccelerated() const = 0;
};

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
