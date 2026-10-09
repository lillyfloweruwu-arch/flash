#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>
namespace flash {
// Native handles are borrowed for the callback lifetime and interpreted only by
// the matching platform encoder. CPU capture uses data and leaves them null.
struct FrameData {
    uint8_t* data = nullptr;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    int64_t timestamp_us; // microseconds since capture start
    void* texture = nullptr;
    void* device = nullptr;
    bool rgb = false;
};

struct DisplayInfo {
    uint32_t id;
    std::string name;
    uint32_t width;
    uint32_t height;
    bool isPrimary;
    // Capture cannot produce more distinct frames than the display refreshes.
    // Asking for more just records duplicates at a higher bitrate, so the app
    // needs this to say so rather than letting the setting quietly lie.
    uint32_t refreshHz;
};

using FrameCallback = std::function<void(const FrameData& frame)>;

class VideoSource {
public:
    virtual ~VideoSource() = default;
    virtual bool Initialize(uint32_t fps, uint32_t width, uint32_t height, uint32_t display) = 0;
    virtual bool Start(FrameCallback callback) = 0;
    virtual void Stop() = 0;
    virtual void SaveScreenshot(const std::string& path) = 0;
    virtual bool IsCapturing() const = 0;
    virtual bool IsHealthy() const = 0;
    virtual bool IsPending() const { return false; }
    virtual std::string GetCaptureError() const = 0;
    virtual std::string GetCaptureBackend() const = 0;
    virtual uint32_t GetWidth() const = 0;
    virtual uint32_t GetHeight() const = 0;
    virtual uint32_t GetOutputWidth() const = 0;
    virtual uint32_t GetOutputHeight() const = 0;
    virtual void SetGpuOutputEnabled(bool enabled) = 0;
    virtual bool HasGpuOutput() const = 0;
    virtual void* GetDevice() const = 0;
};
} // namespace flash
