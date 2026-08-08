#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <atomic>
#include <thread>

#ifdef _WIN32
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

struct FrameData {
    uint8_t* data;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    int64_t timestamp_us; // microseconds since capture start
};

using FrameCallback = std::function<void(const FrameData& frame)>;

class ScreenCapture {
public:
    ScreenCapture();
    ~ScreenCapture();

    // Initialize DXGI Desktop Duplication on primary monitor
    bool Initialize(uint32_t targetFps = 60);

    // Start capturing frames, calling callback for each
    bool Start(FrameCallback callback);

    // Stop capture
    void Stop();

    // Query state
    bool IsCapturing() const { return capturing_.load(); }
    uint32_t GetWidth() const { return width_; }
    uint32_t GetHeight() const { return height_; }

private:
    void CaptureLoop();

    std::atomic<bool> capturing_{false};
    std::thread captureThread_;
    FrameCallback callback_;
    uint32_t targetFps_ = 60;
    uint32_t width_ = 0;
    uint32_t height_ = 0;

#ifdef _WIN32
    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGIOutputDuplication> duplication_;
    ComPtr<ID3D11Texture2D> stagingTexture_;
#endif
};

} // namespace flash
