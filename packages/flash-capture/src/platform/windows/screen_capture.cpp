#include "screen_capture.h"
#include "../../core/capture_clock.h"
#include "frame_source.h"
#include "png_writer.h"
#include "color_space.h"
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <functional>
#include <stdexcept>

#ifdef _WIN32
#include <Windows.h>
#include <dxgi1_2.h>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#endif

namespace flash {

#ifdef _WIN32
namespace {

bool IsDeviceLost(HRESULT hr) {
    return hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET;
}

// The CPU readback path still works, so this is not fatal, but it is much
// slower and used to be invisible. Say why the GPU path was not set up.
void ReportGpuConversionFallback(const char* reason) {
    std::fprintf(stderr, "flash: GPU colour conversion unavailable (%s); using CPU conversion\n", reason);
}

class DuplicationSource final : public FrameSource {
public:
    DuplicationSource(ID3D11Device* device, ID3D11DeviceContext* context,
                      std::atomic<bool>& capturing,
                      std::function<bool(uint32_t, uint32_t)> resizeFrameResources,
                      std::function<void(const std::string&)> reportError)
        : device_(device), context_(context), capturing_(capturing),
          resizeFrameResources_(std::move(resizeFrameResources)),
          reportError_(std::move(reportError)) {}

    ~DuplicationSource() override { Stop(); }

    bool Start(uint32_t displayId, uint32_t fps) override {
        Stop();
        displayId_ = displayId;
        fps_ = fps;
        return CreateDuplication();
    }

    bool Next(SourceFrame& frame, uint32_t timeoutMs) override {
        frame = {};
        ComPtr<IDXGIResource> resource;
        DXGI_OUTDUPL_FRAME_INFO info{};
        const HRESULT hr = duplication_
            ? duplication_->AcquireNextFrame(static_cast<UINT>(timeoutMs), &info, &resource)
            : DXGI_ERROR_ACCESS_LOST;
        frame.timestampUs = CaptureClockUs();
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
            frame.texture = previousDesktopTexture_.Get();
            return true;
        }
        if (hr == DXGI_ERROR_ACCESS_LOST || hr == E_ACCESSDENIED) {
            if (!RecreateDuplication()) capturing_.store(false);
            return false;
        }
        if (IsDeviceLost(hr)) {
            reportError_("D3D11 device was removed or reset; pipeline rebuild required");
            capturing_.store(false);
            return false;
        }
        if (FAILED(hr)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            return false;
        }

        ComPtr<ID3D11Texture2D> desktop;
        if (SUCCEEDED(resource.As(&desktop))) {
            D3D11_TEXTURE2D_DESC desc{};
            desktop->GetDesc(&desc);
            if (!previousDesktopTexture_) {
                desc.BindFlags = 0;
                desc.MiscFlags = 0;
                desc.CPUAccessFlags = 0;
                desc.Usage = D3D11_USAGE_DEFAULT;
                device_->CreateTexture2D(&desc, nullptr, &previousDesktopTexture_);
            }
            if (previousDesktopTexture_) {
                context_->CopyResource(previousDesktopTexture_.Get(), desktop.Get());
                frame.texture = previousDesktopTexture_.Get();
            }
        }
        duplication_->ReleaseFrame();
        return frame.texture != nullptr;
    }

    void Stop() override {
        previousDesktopTexture_.Reset();
        duplication_.Reset();
    }

    const char* Name() const override { return "Desktop Duplication"; }

    uint32_t Width() const { return width_; }
    uint32_t Height() const { return height_; }

private:
    bool CreateDuplication() {
        ComPtr<IDXGIDevice> dxgiDevice;
        ComPtr<IDXGIAdapter> adapter;
        lastDuplicationError_ = device_.As(&dxgiDevice);
        if (FAILED(lastDuplicationError_)) return false;
        lastDuplicationError_ = dxgiDevice->GetAdapter(&adapter);
        if (FAILED(lastDuplicationError_)) return false;
        ComPtr<IDXGIOutput> selected;
        uint32_t id = 0;
        ComPtr<IDXGIFactory1> factory;
        lastDuplicationError_ = adapter->GetParent(IID_PPV_ARGS(&factory));
        if (FAILED(lastDuplicationError_)) return false;
        for (UINT ai = 0; !selected; ++ai) {
            ComPtr<IDXGIAdapter1> candidate;
            if (factory->EnumAdapters1(ai, &candidate) == DXGI_ERROR_NOT_FOUND) break;
            for (UINT oi = 0;; ++oi) {
                ComPtr<IDXGIOutput> output;
                if (candidate->EnumOutputs(oi, &output) == DXGI_ERROR_NOT_FOUND) break;
                if (id++ == displayId_) {
                    selected = output;
                    break;
                }
            }
        }
        if (!selected) {
            lastDuplicationError_ = DXGI_ERROR_NOT_FOUND;
            return false;
        }
        ComPtr<IDXGIOutput1> output1;
        HRESULT duplicateHr = selected.As(&output1);
        if (SUCCEEDED(duplicateHr)) {
            duplicateHr = output1->DuplicateOutput(device_.Get(), &duplication_);
        }
        lastDuplicationError_ = duplicateHr;
        if (FAILED(duplicateHr)) return false;
        DXGI_OUTDUPL_DESC desc{};
        duplication_->GetDesc(&desc);
        width_ = desc.ModeDesc.Width;
        height_ = desc.ModeDesc.Height;
        return true;
    }

    bool RecreateDuplication() {
        const uint32_t previousWidth = width_;
        const uint32_t previousHeight = height_;
        previousDesktopTexture_.Reset();
        int backoffMs = 100;
        while (capturing_.load()) {
            duplication_.Reset();
            if (CreateDuplication()) {
                if ((width_ == previousWidth && height_ == previousHeight) ||
                    resizeFrameResources_(width_, height_)) {
                    return true;
                }
            }
            const HRESULT reason = device_ ? device_->GetDeviceRemovedReason() : lastDuplicationError_;
            if (IsDeviceLost(lastDuplicationError_) || IsDeviceLost(reason)) {
                reportError_("D3D11 device was removed or reset; pipeline rebuild required");
                return false;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(backoffMs));
            backoffMs = (std::min)(backoffMs * 2, 1000);
        }
        return false;
    }

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    std::atomic<bool>& capturing_;
    std::function<bool(uint32_t, uint32_t)> resizeFrameResources_;
    std::function<void(const std::string&)> reportError_;
    ComPtr<IDXGIOutputDuplication> duplication_;
    ComPtr<ID3D11Texture2D> previousDesktopTexture_;
    uint32_t displayId_ = 0;
    uint32_t fps_ = 0;
    uint32_t width_ = 0;
    uint32_t height_ = 0;
    HRESULT lastDuplicationError_ = S_OK;
};

} // namespace
#endif

ScreenCapture::ScreenCapture() = default;
ScreenCapture::~ScreenCapture() {
    Stop();
#ifdef _WIN32
    if (source_) source_->Stop();
#endif
}

std::vector<DisplayInfo> ScreenCapture::ListDisplays() {
    std::vector<DisplayInfo> displays;
#ifdef _WIN32
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return displays;
    uint32_t id = 0;
    for (UINT ai = 0;; ++ai) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(ai, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT oi = 0;; ++oi) {
            ComPtr<IDXGIOutput> output;
            if (adapter->EnumOutputs(oi, &output) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_OUTPUT_DESC desc{};
            if (FAILED(output->GetDesc(&desc))) continue;
            const auto& r = desc.DesktopCoordinates;
            char name[64]{};
            WideCharToMultiByte(CP_UTF8, 0, desc.DeviceName, -1, name, sizeof(name), nullptr, nullptr);
            // DXGI_OUTPUT_DESC carries no refresh rate, but it does carry the
            // device name the display settings API wants.
            DEVMODEW mode{};
            mode.dmSize = sizeof(mode);
            const uint32_t refreshHz =
                EnumDisplaySettingsW(desc.DeviceName, ENUM_CURRENT_SETTINGS, &mode)
                    ? mode.dmDisplayFrequency : 0;
            displays.push_back({id++, name, static_cast<uint32_t>(r.right - r.left),
                static_cast<uint32_t>(r.bottom - r.top), r.left == 0 && r.top == 0, refreshHz, r.left, r.top});
        }
    }
#endif
    return displays;
}

bool ScreenCapture::CreateFrameResources() {
#ifdef _WIN32
    stagingTexture_.Reset(); videoDevice_.Reset(); videoContext_.Reset();
    videoEnumerator_.Reset(); videoProcessor_.Reset(); nv12Texture_.Reset(); outputView_.Reset();
    D3D11_TEXTURE2D_DESC staging{};
    staging.Width = width_; staging.Height = height_; staging.MipLevels = 1; staging.ArraySize = 1;
    staging.Format = DXGI_FORMAT_B8G8R8A8_UNORM; staging.SampleDesc.Count = 1;
    staging.Usage = D3D11_USAGE_STAGING; staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(device_->CreateTexture2D(&staging, nullptr, &stagingTexture_))) return false;

    if (FAILED(device_.As(&videoDevice_)) || FAILED(context_.As(&videoContext_))) {
        ReportGpuConversionFallback("video device/context unavailable");
        return true;
    }
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = width_; content.InputHeight = height_;
    content.OutputWidth = outputWidth_; content.OutputHeight = outputHeight_;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    content.InputFrameRate = {targetFps_, 1}; content.OutputFrameRate = {targetFps_, 1};
    if (FAILED(videoDevice_->CreateVideoProcessorEnumerator(&content, &videoEnumerator_)) ||
        FAILED(videoDevice_->CreateVideoProcessor(videoEnumerator_.Get(), 0, &videoProcessor_))) {
        ReportGpuConversionFallback("video processor creation failed");
        return true;
    }
    // Say what goes in and what must come out. The default is BT.601, which the
    // decoder then undoes as BT.709 and oversaturates the clip.
    const auto inputSpace = FullRangeRgbColorSpace();
    const auto outputSpace = Bt709LimitedColorSpace();
    videoContext_->VideoProcessorSetStreamColorSpace(videoProcessor_.Get(), 0, &inputSpace);
    videoContext_->VideoProcessorSetOutputColorSpace(videoProcessor_.Get(), &outputSpace);
    D3D11_TEXTURE2D_DESC nv12{};
    nv12.Width = outputWidth_; nv12.Height = outputHeight_; nv12.MipLevels = 1; nv12.ArraySize = 1;
    nv12.Format = DXGI_FORMAT_NV12; nv12.SampleDesc.Count = 1; nv12.Usage = D3D11_USAGE_DEFAULT;
    nv12.BindFlags = D3D11_BIND_RENDER_TARGET;
    if (FAILED(device_->CreateTexture2D(&nv12, nullptr, &nv12Texture_))) {
        ReportGpuConversionFallback("NV12 texture creation failed");
        return true;
    }
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outDesc{};
    outDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    if (FAILED(videoDevice_->CreateVideoProcessorOutputView(nv12Texture_.Get(), videoEnumerator_.Get(), &outDesc, &outputView_))) {
        nv12Texture_.Reset();
        ReportGpuConversionFallback("output view creation failed");
        return true;
    }
    return true;
#else
    return false;
#endif
}

bool ScreenCapture::Initialize(uint32_t targetFps, uint32_t outputWidth, uint32_t outputHeight, uint32_t displayId) {
    Stop(); targetFps_ = targetFps; outputWidth_ = outputWidth; outputHeight_ = outputHeight; displayId_ = displayId;
#ifdef _WIN32
    if (source_) source_->Stop();
    source_.reset(); context_.Reset(); device_.Reset();
    ComPtr<IDXGIFactory1> factory; ComPtr<IDXGIAdapter1> selectedAdapter;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
    uint32_t flatId = 0;
    for (UINT ai = 0; !selectedAdapter; ++ai) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(ai, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT oi = 0;; ++oi) {
            ComPtr<IDXGIOutput> output;
            if (adapter->EnumOutputs(oi, &output) == DXGI_ERROR_NOT_FOUND) break;
            if (flatId++ == displayId_) { selectedAdapter = adapter; break; }
        }
    }
    if (!selectedAdapter) return false;
    D3D_FEATURE_LEVEL level;
    HRESULT createHr = D3D11CreateDevice(selectedAdapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
        D3D11_SDK_VERSION, &device_, &level, &context_);
    if (FAILED(createHr)) return false;
    ComPtr<ID3D10Multithread> multithread;
    if (SUCCEEDED(context_.As(&multithread))) multithread->SetMultithreadProtected(TRUE);
    // Windows.Graphics.Capture first, because Desktop Duplication cannot see a
    // fullscreen-exclusive swapchain and hands back a near-black frame instead
    // of the game. Duplication remains the fallback: WGC is absent before
    // Windows 10 1803 and can fail to start for reasons worth degrading over
    // rather than refusing to record at all.
    std::unique_ptr<FrameSource> source;
    if (auto preferred = CreateWgcSource(device_.Get())) {
        if (preferred->Start(displayId_, targetFps_)) source = std::move(preferred);
    }
    if (!source) {
        auto fallback = std::make_unique<DuplicationSource>(device_.Get(), context_.Get(), capturing_,
            [this](uint32_t width, uint32_t height) {
                width_ = width;
                height_ = height;
                return CreateFrameResources();
            },
            [this](const std::string& error) { SetCaptureError(error); });
        if (!fallback->Start(displayId_, targetFps_)) return false;
        source = std::move(fallback);
    }
    width_ = source->Width();
    height_ = source->Height();
    source_ = std::move(source);
    if (!CreateFrameResources()) return false;
    return true;
#else
    return false;
#endif
}

bool ScreenCapture::Start(FrameCallback callback) {
    std::lock_guard lock(stopMutex_);
    if (capturing_.exchange(true)) return false;
    if (captureThread_.joinable()) captureThread_.join();
#ifdef _WIN32
    { std::lock_guard frameLock(latestFrameMutex_); latestBgraTexture_.Reset(); }
#endif
    { std::lock_guard statusLock(statusMutex_); captureError_.clear(); }
    captureHealthy_.store(true);
    callback_ = std::move(callback); captureThread_ = std::thread(&ScreenCapture::CaptureLoop, this); return true;
}

void ScreenCapture::Stop() {
    std::lock_guard lock(stopMutex_);
    capturing_.store(false);
    if (captureThread_.joinable() && captureThread_.get_id() != std::this_thread::get_id()) captureThread_.join();
    captureHealthy_.store(false);
}

void ScreenCapture::SaveScreenshot(const std::string& path) {
    if (!capturing_.load()) throw std::runtime_error("capture is not running");
    if (path.empty()) throw std::invalid_argument("screenshot path must not be empty");
#ifdef _WIN32
    ComPtr<ID3D11Texture2D> readback;
    D3D11_TEXTURE2D_DESC desc{};
    {
        std::lock_guard lock(latestFrameMutex_);
        if (!latestBgraTexture_) throw std::runtime_error("no capture frame has arrived yet");
        latestBgraTexture_->GetDesc(&desc);
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        desc.Usage = D3D11_USAGE_STAGING;
        const HRESULT createHr = device_->CreateTexture2D(&desc, nullptr, &readback);
        if (FAILED(createHr)) throw std::runtime_error("failed to create screenshot staging texture");
        context_->CopyResource(readback.Get(), latestBgraTexture_.Get());
    }

    D3D11_MAPPED_SUBRESOURCE mapped{};
    const HRESULT mapHr = context_->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(mapHr)) throw std::runtime_error("failed to map screenshot staging texture");
    try {
        WritePng(path, static_cast<const uint8_t*>(mapped.pData),
            desc.Width, desc.Height, mapped.RowPitch);
    } catch (...) {
        context_->Unmap(readback.Get(), 0);
        throw;
    }
    context_->Unmap(readback.Get(), 0);
#else
    (void)path;
    throw std::runtime_error("screenshots are only supported on Windows");
#endif
}

void ScreenCapture::SetCaptureError(const std::string& error) {
    { std::lock_guard lock(statusMutex_); captureError_ = error; }
    captureHealthy_.store(false);
}

std::string ScreenCapture::GetCaptureError() const {
    std::lock_guard lock(statusMutex_); return captureError_;
}

std::string ScreenCapture::GetCaptureBackend() const {
#ifdef _WIN32
    return source_ ? source_->Name() : "none";
#else
    return "none";
#endif
}

void ScreenCapture::DeliverFrame(ID3D11Texture2D* texture, int64_t timestampUs) {
#ifdef _WIN32
    if (texture) {
        std::lock_guard lock(latestFrameMutex_);
        D3D11_TEXTURE2D_DESC sourceDesc{};
        texture->GetDesc(&sourceDesc);
        D3D11_TEXTURE2D_DESC latestDesc{};
        if (latestBgraTexture_) latestBgraTexture_->GetDesc(&latestDesc);
        if (!latestBgraTexture_ || latestDesc.Width != sourceDesc.Width ||
            latestDesc.Height != sourceDesc.Height || latestDesc.Format != sourceDesc.Format) {
            latestBgraTexture_.Reset();
            sourceDesc.BindFlags = 0;
            sourceDesc.MiscFlags = 0;
            sourceDesc.CPUAccessFlags = 0;
            sourceDesc.Usage = D3D11_USAGE_DEFAULT;
            if (FAILED(device_->CreateTexture2D(&sourceDesc, nullptr, &latestBgraTexture_))) {
                SetCaptureError("failed to allocate latest screenshot texture");
            }
        }
        if (latestBgraTexture_) context_->CopyResource(latestBgraTexture_.Get(), texture);
    }
    FrameData frame{}; frame.timestamp_us = timestampUs; frame.device = device_.Get();
    if (gpuOutputEnabled_.load() && texture && videoProcessor_ && outputView_) {
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inDesc{};
        inDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        ComPtr<ID3D11VideoProcessorInputView> inputView;
        if (SUCCEEDED(videoDevice_->CreateVideoProcessorInputView(texture, videoEnumerator_.Get(), &inDesc, &inputView))) {
            D3D11_VIDEO_PROCESSOR_STREAM stream{}; stream.Enable = TRUE; stream.pInputSurface = inputView.Get();
            if (SUCCEEDED(videoContext_->VideoProcessorBlt(videoProcessor_.Get(), outputView_.Get(), 0, 1, &stream))) {
                frame.width = outputWidth_; frame.height = outputHeight_; frame.texture = nv12Texture_.Get(); callback_(frame); return;
            }
        }
    }
    if (!texture || !stagingTexture_) return;
    context_->CopyResource(stagingTexture_.Get(), texture);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (SUCCEEDED(context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped))) {
        frame.data = static_cast<uint8_t*>(mapped.pData); frame.width = width_; frame.height = height_; frame.stride = mapped.RowPitch;
        callback_(frame); context_->Unmap(stagingTexture_.Get(), 0);
    }
#endif
}

void ScreenCapture::CaptureLoop() {
    using clock = std::chrono::steady_clock;
    const auto duration = std::chrono::microseconds(1000000 / targetFps_);
#ifdef _WIN32
    // Windows' default timer granularity is ~15.6ms, so std::this_thread::sleep_for
    // of a sub-millisecond remainder actually sleeps a whole tick. That capped
    // capture at ~32fps (16ms AcquireNextFrame + a 15.6ms quantised sleep) and made
    // frame intervals lurch between 15ms and 123ms — which is what reads as choppy
    // playback. A high-resolution waitable timer hits the real deadline without
    // raising the global timer resolution for the entire system the way
    // timeBeginPeriod(1) would.
    HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr,
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);

    while (capturing_.load()) {
        const auto frameStart = clock::now();
        SourceFrame frame{};
        // The source can change size under us - a game switching display mode.
        // The staging texture and the video processor are both built from these
        // dimensions, so they have to be rebuilt before the next frame is
        // converted, or the new picture lands in the corner of a buffer still
        // holding the old one.
        if (source_ && (source_->Width() != width_ || source_->Height() != height_) &&
            source_->Width() && source_->Height()) {
            width_ = source_->Width();
            height_ = source_->Height();
            if (!CreateFrameResources()) {
                SetCaptureError("could not rebuild capture resources after a display mode change");
                capturing_.store(false);
                break;
            }
        }
        if (source_ && source_->Next(frame, 1000 / targetFps_)) {
            DeliverFrame(frame.texture, frame.timestampUs);
        }
        // Checked after the frame, not instead of it: a source that has just
        // died still hands back its last image, and recording that forever is
        // worse than stopping, because the clip looks fine until you watch it.
        // The watchdog restarts from here.
        if (source_) {
            if (const char* failure = source_->Failure()) {
                SetCaptureError(failure);
                capturing_.store(false);
                break;
            }
        }
        const auto elapsed = clock::now() - frameStart;
        if (elapsed < duration) {
            const auto remaining = std::chrono::duration_cast<std::chrono::nanoseconds>(duration - elapsed);
            if (timer) {
                LARGE_INTEGER due{};
                due.QuadPart = -(remaining.count() / 100);   // negative = relative, 100ns units
                if (SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE)) WaitForSingleObject(timer, INFINITE);
            } else {
                std::this_thread::sleep_for(remaining);   // pre-1803 fallback
            }
        }
    }
    if (timer) CloseHandle(timer);
#endif
    captureHealthy_.store(false);
}

} // namespace flash
