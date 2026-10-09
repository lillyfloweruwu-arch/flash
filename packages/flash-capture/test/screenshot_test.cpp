#include "../src/platform/windows/screen_capture.h"

#include <Windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

std::string Utf8(const std::wstring& value) {
    const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    assert(length > 0);
    std::string result(static_cast<size_t>(length), '\0');
    assert(WideCharToMultiByte(CP_UTF8, 0, value.data(),
        static_cast<int>(value.size()), result.data(), length, nullptr, nullptr) == length);
    return result;
}

struct DecodedPng {
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<uint8_t> bgra;
};

DecodedPng DecodePng(const std::filesystem::path& path) {
    ComPtr<IWICImagingFactory> factory;
    assert(SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory))));
    ComPtr<IWICBitmapDecoder> decoder;
    assert(SUCCEEDED(factory->CreateDecoderFromFilename(path.c_str(), nullptr,
        GENERIC_READ, WICDecodeMetadataCacheOnLoad, &decoder)));
    ComPtr<IWICBitmapFrameDecode> frame;
    assert(SUCCEEDED(decoder->GetFrame(0, &frame)));

    DecodedPng result;
    assert(SUCCEEDED(frame->GetSize(&result.width, &result.height)));
    ComPtr<IWICFormatConverter> converter;
    assert(SUCCEEDED(factory->CreateFormatConverter(&converter)));
    assert(SUCCEEDED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppBGRA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom)));
    const uint32_t stride = result.width * 4;
    result.bgra.resize(static_cast<size_t>(stride) * result.height);
    assert(SUCCEEDED(converter->CopyPixels(nullptr, stride,
        static_cast<UINT>(result.bgra.size()), result.bgra.data())));
    return result;
}

} // namespace

int main() {
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    assert(SUCCEEDED(comResult) || comResult == RPC_E_CHANGED_MODE);

    const auto path = std::filesystem::temp_directory_path() /
        (L"flash-screenshot-probe-" + std::to_wstring(GetCurrentProcessId()) + L".png");
    uint32_t expectedWidth = 0;
    uint32_t expectedHeight = 0;

    // Scoped so every D3D and WinRT interface the capture holds is released
    // before CoUninitialize below. Releasing a COM interface after the
    // apartment is gone is an access violation, and because it happens during
    // teardown it looks exactly like the feature crashing rather than like the
    // test tearing down in the wrong order.
    {
        const auto displays = flash::ScreenCapture::ListDisplays();
        assert(!displays.empty());
        const auto& display = displays.front();
        flash::ScreenCapture capture;
        assert(capture.Initialize(30, display.width, display.height, display.id));

        std::atomic<uint32_t> delivered{0};
        assert(capture.Start([&](const flash::FrameData&) { delivered.fetch_add(1); }));
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!delivered.load() && std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        assert(delivered.load() > 0);

        expectedWidth = capture.GetWidth();
        expectedHeight = capture.GetHeight();
        capture.SaveScreenshot(Utf8(path.wstring()));
        capture.Stop();
    }

    const DecodedPng decoded = DecodePng(path);
    assert(decoded.width == expectedWidth);
    assert(decoded.height == expectedHeight);
    bool hasNonBlackPixel = false;
    for (size_t i = 0; i + 3 < decoded.bgra.size(); i += 4) {
        if (decoded.bgra[i] || decoded.bgra[i + 1] || decoded.bgra[i + 2]) {
            hasNonBlackPixel = true;
            break;
        }
    }
    assert(hasNonBlackPixel);

    std::error_code removeError;
    std::filesystem::remove(path, removeError);
    assert(!removeError);
    if (SUCCEEDED(comResult)) CoUninitialize();
    std::printf("screenshot self-check passed: %ux%u PNG decoded and is not uniformly black\n",
        decoded.width, decoded.height);
    return 0;
}
