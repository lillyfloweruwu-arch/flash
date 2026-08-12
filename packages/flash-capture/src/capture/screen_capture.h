#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <atomic>
#include <thread>
#include <vector>
#include <mutex>

#ifdef _WIN32
#include <d3d11.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

class FrameSource;

struct FrameData {
    uint8_t* data = nullptr;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    int64_t timestamp_us; // microseconds since capture start
#ifdef _WIN32
    ID3D11Texture2D* texture = nullptr;
    ID3D11Device* device = nullptr;
#endif
};

struct DisplayInfo {
    uint32_t id;
    std::string name;
    uint32_t width;
    uint32_t height;
    bool isPrimary;
};

using FrameCallback = std::function<void(const FrameData& frame)>;

class ScreenCapture {
public:
    ScreenCapture();
    ~ScreenCapture();

    // Initialize DXGI Desktop Duplication on primary monitor
    bool Initialize(uint32_t targetFps = 60, uint32_t outputWidth = 1920,
                    uint32_t outputHeight = 1080, uint32_t displayId = 0);
    static std::vector<DisplayInfo> ListDisplays();

    // Start capturing frames, calling callback for each
    bool Start(FrameCallback callback);

    // Stop capture
    void Stop();

    // Query state
    bool IsCapturing() const { return capturing_.load(); }
    bool IsHealthy() const { return captureHealthy_.load(); }
    std::string GetCaptureError() const;
    uint32_t GetWidth() const { return width_; }
    uint32_t GetHeight() const { return height_; }
    uint32_t GetOutputWidth() const { return outputWidth_; }
    uint32_t GetOutputHeight() const { return outputHeight_; }
    void SetGpuOutputEnabled(bool enabled) { gpuOutputEnabled_ = enabled; }
    bool HasGpuOutput() const { return nv12Texture_ && outputView_; }
#ifdef _WIN32
    ID3D11Device* GetDevice() const { return device_.Get(); }
#endif

private:
    void CaptureLoop();
    bool CreateFrameResources();
    void SetCaptureError(const std::string& error);
    void DeliverFrame(ID3D11Texture2D* desktopTexture, int64_t timestampUs);

    std::atomic<bool> capturing_{false};
    std::atomic<bool> captureHealthy_{false};
    std::thread captureThread_;
    FrameCallback callback_;
    uint32_t targetFps_ = 60;
    uint32_t width_ = 0;
    uint32_t height_ = 0;
    uint32_t outputWidth_ = 0;
    uint32_t outputHeight_ = 0;
    uint32_t displayId_ = 0;
    std::mutex stopMutex_;
    mutable std::mutex statusMutex_;
    std::string captureError_;
    std::atomic<bool> gpuOutputEnabled_{true};

#ifdef _WIN32
    std::unique_ptr<FrameSource> source_;
    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<ID3D11Texture2D> stagingTexture_;
    ComPtr<ID3D11VideoDevice> videoDevice_;
    ComPtr<ID3D11VideoContext> videoContext_;
    ComPtr<ID3D11VideoProcessorEnumerator> videoEnumerator_;
    ComPtr<ID3D11VideoProcessor> videoProcessor_;
    ComPtr<ID3D11Texture2D> nv12Texture_;
    ComPtr<ID3D11VideoProcessorOutputView> outputView_;
#endif
};

} // namespace flash
