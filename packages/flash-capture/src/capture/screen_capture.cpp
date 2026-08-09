#include "screen_capture.h"
#include "capture_clock.h"
#include <chrono>

#ifdef _WIN32
#include <Windows.h>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#endif

namespace flash {

ScreenCapture::ScreenCapture() = default;
ScreenCapture::~ScreenCapture() { Stop(); }

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
            displays.push_back({id++, name, static_cast<uint32_t>(r.right - r.left),
                static_cast<uint32_t>(r.bottom - r.top), r.left == 0 && r.top == 0});
        }
    }
#endif
    return displays;
}

bool ScreenCapture::CreateDuplication() {
#ifdef _WIN32
    ComPtr<IDXGIDevice> dxgiDevice;
    ComPtr<IDXGIAdapter> adapter;
    if (FAILED(device_.As(&dxgiDevice)) || FAILED(dxgiDevice->GetAdapter(&adapter))) return false;
    ComPtr<IDXGIOutput> selected;
    uint32_t id = 0;
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(adapter->GetParent(IID_PPV_ARGS(&factory)))) return false;
    for (UINT ai = 0; !selected; ++ai) {
        ComPtr<IDXGIAdapter1> candidate;
        if (factory->EnumAdapters1(ai, &candidate) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT oi = 0;; ++oi) {
            ComPtr<IDXGIOutput> output;
            if (candidate->EnumOutputs(oi, &output) == DXGI_ERROR_NOT_FOUND) break;
            if (id++ == displayId_) { selected = output; break; }
        }
    }
    if (!selected) return false;
    ComPtr<IDXGIOutput1> output1;
    HRESULT duplicateHr = selected.As(&output1);
    if (SUCCEEDED(duplicateHr)) duplicateHr = output1->DuplicateOutput(device_.Get(), &duplication_);
    if (FAILED(duplicateHr)) return false;
    DXGI_OUTDUPL_DESC desc{};
    duplication_->GetDesc(&desc);
    width_ = desc.ModeDesc.Width; height_ = desc.ModeDesc.Height;
    return true;
#else
    return false;
#endif
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

    if (FAILED(device_.As(&videoDevice_)) || FAILED(context_.As(&videoContext_))) return true;
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = width_; content.InputHeight = height_;
    content.OutputWidth = outputWidth_; content.OutputHeight = outputHeight_;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    content.InputFrameRate = {targetFps_, 1}; content.OutputFrameRate = {targetFps_, 1};
    if (FAILED(videoDevice_->CreateVideoProcessorEnumerator(&content, &videoEnumerator_)) ||
        FAILED(videoDevice_->CreateVideoProcessor(videoEnumerator_.Get(), 0, &videoProcessor_))) return true;
    D3D11_TEXTURE2D_DESC nv12{};
    nv12.Width = outputWidth_; nv12.Height = outputHeight_; nv12.MipLevels = 1; nv12.ArraySize = 1;
    nv12.Format = DXGI_FORMAT_NV12; nv12.SampleDesc.Count = 1; nv12.Usage = D3D11_USAGE_DEFAULT;
    nv12.BindFlags = D3D11_BIND_RENDER_TARGET;
    if (FAILED(device_->CreateTexture2D(&nv12, nullptr, &nv12Texture_))) return true;
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outDesc{};
    outDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    if (FAILED(videoDevice_->CreateVideoProcessorOutputView(nv12Texture_.Get(), videoEnumerator_.Get(), &outDesc, &outputView_))) {
        nv12Texture_.Reset(); return true;
    }
    return true;
#else
    return false;
#endif
}

bool ScreenCapture::Initialize(uint32_t targetFps, uint32_t outputWidth, uint32_t outputHeight, uint32_t displayId) {
    Stop(); targetFps_ = targetFps; outputWidth_ = outputWidth; outputHeight_ = outputHeight; displayId_ = displayId;
#ifdef _WIN32
    duplication_.Reset(); context_.Reset(); device_.Reset();
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
    if (!CreateDuplication()) return false;
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
    callback_ = std::move(callback); captureThread_ = std::thread(&ScreenCapture::CaptureLoop, this); return true;
}

void ScreenCapture::Stop() {
    std::lock_guard lock(stopMutex_);
    capturing_.store(false);
    if (captureThread_.joinable() && captureThread_.get_id() != std::this_thread::get_id()) captureThread_.join();
}

bool ScreenCapture::RecreateDuplication() {
    duplication_.Reset(); previousDesktopTexture_.Reset();
    for (int attempt = 0; attempt < 10 && capturing_.load(); ++attempt) {
        if (CreateDuplication()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    return false;
}

void ScreenCapture::DeliverFrame(ID3D11Texture2D* texture, int64_t timestampUs) {
#ifdef _WIN32
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
    while (capturing_.load()) {
        const auto frameStart = clock::now();
        ComPtr<IDXGIResource> resource; DXGI_OUTDUPL_FRAME_INFO info{};
        HRESULT hr = duplication_ ? duplication_->AcquireNextFrame(static_cast<UINT>(1000 / targetFps_), &info, &resource) : DXGI_ERROR_ACCESS_LOST;
        const int64_t timestamp = CaptureClockUs();
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
            DeliverFrame(previousDesktopTexture_.Get(), timestamp);
        } else if (hr == DXGI_ERROR_ACCESS_LOST) {
            if (!RecreateDuplication()) { capturing_.store(false); break; }
        } else if (FAILED(hr)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        } else {
            ComPtr<ID3D11Texture2D> desktop;
            if (SUCCEEDED(resource.As(&desktop))) {
                D3D11_TEXTURE2D_DESC desc{}; desktop->GetDesc(&desc);
                if (!previousDesktopTexture_) {
                    desc.BindFlags = 0; desc.MiscFlags = 0; desc.CPUAccessFlags = 0; desc.Usage = D3D11_USAGE_DEFAULT;
                    device_->CreateTexture2D(&desc, nullptr, &previousDesktopTexture_);
                }
                if (previousDesktopTexture_) context_->CopyResource(previousDesktopTexture_.Get(), desktop.Get());
                DeliverFrame(desktop.Get(), timestamp);
            }
            duplication_->ReleaseFrame();
        }
        const auto elapsed = clock::now() - frameStart;
        if (elapsed < duration) std::this_thread::sleep_for(duration - elapsed);
    }
#endif
}

} // namespace flash
