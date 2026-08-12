#include "frame_source.h"
#include "capture_clock.h"

#ifdef _WIN32
#include <Windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <inspectable.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <Windows.Graphics.Capture.Interop.h>
#include <wrl/client.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <memory>
#include <string>

using Microsoft::WRL::ComPtr;
namespace capture = winrt::Windows::Graphics::Capture;
namespace directx = winrt::Windows::Graphics::DirectX;
#endif

namespace flash {

#ifdef _WIN32
namespace {

// Desktop Duplication cannot see a fullscreen-exclusive swapchain: it hands
// back a near-black frame instead of the game. Windows.Graphics.Capture can,
// which is the entire reason this backend exists.
class WgcSource final : public FrameSource {
public:
    explicit WgcSource(ID3D11Device* device) : device_(device) {}
    ~WgcSource() override { Stop(); }

    bool Start(uint32_t displayId, uint32_t fps) override;
    bool Next(SourceFrame& frame, uint32_t timeoutMs) override;
    void Stop() override;
    const char* Name() const override { return "Windows.Graphics.Capture"; }
    uint32_t Width() const override { return width_; }
    uint32_t Height() const override { return height_; }

private:
    void ReleaseCurrentFrame();

    ID3D11Device* device_ = nullptr;
    capture::GraphicsCaptureItem item_{nullptr};
    capture::Direct3D11CaptureFramePool pool_{nullptr};
    capture::GraphicsCaptureSession session_{nullptr};
    capture::Direct3D11CaptureFrame current_{nullptr};
    ComPtr<ID3D11Texture2D> currentTexture_;
    uint32_t targetFps_ = 60;
    uint32_t width_ = 0;
    uint32_t height_ = 0;
};

// Display ids have to keep meaning what they already mean, so the monitor is
// found by walking adapters and outputs in exactly the order
// ScreenCapture::ListDisplays uses.
HMONITOR MonitorForDisplay(uint32_t displayId) {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return nullptr;
    uint32_t flatId = 0;
    for (UINT adapterIndex = 0;; ++adapterIndex) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(adapterIndex, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT outputIndex = 0;; ++outputIndex) {
            ComPtr<IDXGIOutput> output;
            if (adapter->EnumOutputs(outputIndex, &output) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_OUTPUT_DESC desc{};
            if (FAILED(output->GetDesc(&desc))) continue;
            if (flatId++ == displayId) return desc.Monitor;
        }
    }
    return nullptr;
}

// The yellow capture border can only be turned off from 10.0.19041 onward.
// Older builds capture fine, they just draw the border, so this is a check
// rather than a requirement.
bool BorderCanBeDisabled() {
    try {
        return winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired");
    } catch (...) {
        return false;
    }
}

bool WgcSource::Start(uint32_t displayId, uint32_t fps) {
    if (!device_) return false;
    targetFps_ = fps ? fps : 60;

    try {
        if (!capture::GraphicsCaptureSession::IsSupported()) return false;

        const HMONITOR monitor = MonitorForDisplay(displayId);
        if (!monitor) return false;

        auto interop = winrt::get_activation_factory<capture::GraphicsCaptureItem,
            IGraphicsCaptureItemInterop>();
        if (FAILED(interop->CreateForMonitor(monitor,
                winrt::guid_of<capture::GraphicsCaptureItem>(),
                winrt::put_abi(item_))) || !item_) {
            return false;
        }

        // The frame pool is built on the capture device the encoder already
        // shares, so a frame reaches the encoder without a cross-device copy.
        ComPtr<IDXGIDevice> dxgiDevice;
        if (FAILED(device_->QueryInterface(IID_PPV_ARGS(&dxgiDevice)))) return false;
        winrt::com_ptr<::IInspectable> inspectable;
        if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put()))) {
            return false;
        }
        const auto winrtDevice = inspectable.as<directx::Direct3D11::IDirect3DDevice>();

        // Free-threaded: frames are pulled from the capture thread, which has
        // no message pump of its own.
        const auto size = item_.Size();
        width_ = static_cast<uint32_t>(size.Width);
        height_ = static_cast<uint32_t>(size.Height);
        if (!width_ || !height_) return false;

        pool_ = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
            winrtDevice,
            directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size);
        if (!pool_) return false;

        session_ = pool_.CreateCaptureSession(item_);
        if (!session_) return false;
        if (BorderCanBeDisabled()) session_.IsBorderRequired(false);
        session_.IsCursorCaptureEnabled(true);
        session_.StartCapture();
        return true;
    } catch (...) {
        // WinRT reports failure by throwing. A capture backend that cannot
        // start is not an error worth propagating: the caller falls back to
        // Desktop Duplication.
        Stop();
        return false;
    }
}

void WgcSource::ReleaseCurrentFrame() {
    currentTexture_.Reset();
    if (current_) {
        current_.Close();
        current_ = nullptr;
    }
}

bool WgcSource::Next(SourceFrame& frame, uint32_t timeoutMs) {
    if (!pool_) return false;

    // The previous frame is held until now so its texture stays valid while the
    // encoder reads it. Closing it before pulling the next keeps the pool from
    // starving.
    ReleaseCurrentFrame();

    const uint32_t slice = 2;
    for (uint32_t waited = 0;; waited += slice) {
        try {
            current_ = pool_.TryGetNextFrame();
        } catch (...) {
            return false;
        }
        // A null frame means nothing new has arrived yet, which is ordinary
        // rather than an error.
        if (current_) break;
        if (waited >= timeoutMs) return false;
        Sleep(slice);
    }

    try {
        const auto access = current_.Surface()
            .as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        if (FAILED(access->GetInterface(IID_PPV_ARGS(&currentTexture_))) || !currentTexture_) {
            ReleaseCurrentFrame();
            return false;
        }
        frame.texture = currentTexture_.Get();
        // The frame's own SystemRelativeTime is a QPC value measured since
        // boot. Audio packets and the duplication backend both stamp with
        // CaptureClockUs, so using WGC's clock here puts video and audio on
        // different epochs entirely: every audio packet then looks older than
        // every video frame, gets discarded as out of range, and a full-buffer
        // save stalls the muxer waiting for video to catch up to audio it has
        // already been handed. One clock for both backends.
        frame.timestampUs = CaptureClockUs();
        return true;
    } catch (...) {
        ReleaseCurrentFrame();
        return false;
    }
}

void WgcSource::Stop() {
    ReleaseCurrentFrame();
    try {
        if (session_) { session_.Close(); session_ = nullptr; }
        if (pool_) { pool_.Close(); pool_ = nullptr; }
    } catch (...) { /* already torn down */ }
    item_ = nullptr;
}

} // namespace

std::unique_ptr<FrameSource> CreateWgcSource(ID3D11Device* device) {
    if (!device) return nullptr;
    try {
        if (!capture::GraphicsCaptureSession::IsSupported()) return nullptr;
    } catch (...) {
        return nullptr;
    }
    return std::make_unique<WgcSource>(device);
}

#else

std::unique_ptr<FrameSource> CreateWgcSource(void*) { return nullptr; }

#endif

} // namespace flash
