#include "screen_capture.h"
#include <chrono>

#ifdef _WIN32
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#endif

namespace flash {

ScreenCapture::ScreenCapture() = default;

ScreenCapture::~ScreenCapture() {
    Stop();
}

bool ScreenCapture::Initialize(uint32_t targetFps) {
    targetFps_ = targetFps;

#ifdef _WIN32
    // Create D3D11 device
    D3D_FEATURE_LEVEL featureLevel;
    HRESULT hr = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        0,
        nullptr, 0,
        D3D11_SDK_VERSION,
        &device_,
        &featureLevel,
        &context_
    );
    if (FAILED(hr)) return false;

    // Get DXGI device and adapter
    ComPtr<IDXGIDevice> dxgiDevice;
    hr = device_.As(&dxgiDevice);
    if (FAILED(hr)) return false;

    ComPtr<IDXGIAdapter> adapter;
    hr = dxgiDevice->GetAdapter(&adapter);
    if (FAILED(hr)) return false;

    // Get primary output
    ComPtr<IDXGIOutput> output;
    hr = adapter->EnumOutputs(0, &output);
    if (FAILED(hr)) return false;

    ComPtr<IDXGIOutput1> output1;
    hr = output.As(&output1);
    if (FAILED(hr)) return false;

    // Create desktop duplication
    hr = output1->DuplicateOutput(device_.Get(), &duplication_);
    if (FAILED(hr)) return false;

    // Get output dimensions
    DXGI_OUTDUPL_DESC duplDesc;
    duplication_->GetDesc(&duplDesc);
    width_ = duplDesc.ModeDesc.Width;
    height_ = duplDesc.ModeDesc.Height;

    // Create staging texture for CPU read
    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width = width_;
    stagingDesc.Height = height_;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

    hr = device_->CreateTexture2D(&stagingDesc, nullptr, &stagingTexture_);
    if (FAILED(hr)) return false;

    return true;
#else
    return false; // Windows only for now
#endif
}

bool ScreenCapture::Start(FrameCallback callback) {
    if (capturing_.load()) return false;

    callback_ = callback;
    capturing_.store(true);
    captureThread_ = std::thread(&ScreenCapture::CaptureLoop, this);
    return true;
}

void ScreenCapture::Stop() {
    capturing_.store(false);
    if (captureThread_.joinable()) {
        captureThread_.join();
    }
}

void ScreenCapture::CaptureLoop() {
    using clock = std::chrono::high_resolution_clock;
    auto startTime = clock::now();
    auto frameDuration = std::chrono::microseconds(1000000 / targetFps_);

#ifdef _WIN32
    while (capturing_.load()) {
        auto frameStart = clock::now();

        // Acquire next frame
        ComPtr<IDXGIResource> desktopResource;
        DXGI_OUTDUPL_FRAME_INFO frameInfo;
        HRESULT hr = duplication_->AcquireNextFrame(16, &frameInfo, &desktopResource);

        if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
            continue; // No new frame, try again
        }
        if (FAILED(hr)) {
            // Desktop duplication lost (resolution change, UAC, etc.)
            // Try to reinitialize
            duplication_.Reset();
            Initialize(targetFps_);
            continue;
        }

        // Get the texture
        ComPtr<ID3D11Texture2D> desktopTexture;
        hr = desktopResource.As(&desktopTexture);
        if (SUCCEEDED(hr)) {
            // Copy to staging texture
            context_->CopyResource(stagingTexture_.Get(), desktopTexture.Get());

            // Map and deliver frame
            D3D11_MAPPED_SUBRESOURCE mapped;
            hr = context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped);
            if (SUCCEEDED(hr)) {
                auto now = clock::now();
                auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - startTime);

                FrameData frame;
                frame.data = static_cast<uint8_t*>(mapped.pData);
                frame.width = width_;
                frame.height = height_;
                frame.stride = mapped.RowPitch;
                frame.timestamp_us = elapsed.count();

                callback_(frame);

                context_->Unmap(stagingTexture_.Get(), 0);
            }
        }

        duplication_->ReleaseFrame();

        // Frame pacing
        auto elapsed = clock::now() - frameStart;
        if (elapsed < frameDuration) {
            std::this_thread::sleep_for(frameDuration - elapsed);
        }
    }
#endif
}

} // namespace flash
