#include "png_writer.h"

#include <limits>
#include <stdexcept>

#ifdef _WIN32
#include <Windows.h>
#include <wincodec.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;
#endif

namespace flash {

#ifdef _WIN32
namespace {

class ComScope {
public:
    ComScope() : result_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {
        if (FAILED(result_) && result_ != RPC_E_CHANGED_MODE)
            throw std::runtime_error("failed to initialize COM for PNG encoding");
    }
    ~ComScope() { if (SUCCEEDED(result_)) CoUninitialize(); }
private:
    HRESULT result_;
};

std::wstring Utf8Path(const std::string& path) {
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        path.data(), static_cast<int>(path.size()), nullptr, 0);
    if (!length) throw std::invalid_argument("screenshot path is not valid UTF-8");
    std::wstring wide(static_cast<size_t>(length), L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(),
            static_cast<int>(path.size()), wide.data(), length)) {
        throw std::invalid_argument("screenshot path is not valid UTF-8");
    }
    return wide;
}

void Check(HRESULT result, const char* message) {
    if (FAILED(result)) throw std::runtime_error(message);
}

} // namespace
#endif

void WritePng(const std::string& path, const uint8_t* pixels,
              uint32_t width, uint32_t height, uint32_t stride) {
#ifdef _WIN32
    if (path.empty()) throw std::invalid_argument("screenshot path must not be empty");
    if (!pixels || !width || !height) throw std::invalid_argument("PNG pixels and dimensions are required");
    if (stride < static_cast<uint64_t>(width) * 4)
        throw std::invalid_argument("PNG stride is smaller than one BGRA row");
    const uint64_t bufferSize = static_cast<uint64_t>(stride) * height;
    if (bufferSize > (std::numeric_limits<UINT>::max)())
        throw std::invalid_argument("PNG pixel buffer is too large for WIC");

    ComScope com;
    ComPtr<IWICImagingFactory> factory;
    Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&factory)), "failed to create WIC imaging factory");

    ComPtr<IWICStream> stream;
    Check(factory->CreateStream(&stream), "failed to create WIC output stream");
    const std::wstring widePath = Utf8Path(path);
    Check(stream->InitializeFromFilename(widePath.c_str(), GENERIC_WRITE),
        "screenshot path is not writable");

    ComPtr<IWICBitmapEncoder> encoder;
    Check(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder),
        "failed to create WIC PNG encoder");
    Check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache),
        "failed to initialize WIC PNG encoder");

    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> options;
    Check(encoder->CreateNewFrame(&frame, &options), "failed to create PNG frame");
    Check(frame->Initialize(options.Get()), "failed to initialize PNG frame");
    Check(frame->SetSize(width, height), "failed to set PNG dimensions");
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    Check(frame->SetPixelFormat(&format), "failed to set PNG pixel format");
    if (!IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA))
        throw std::runtime_error("WIC PNG encoder rejected BGRA pixels");

    // RowPitch is intentionally passed through unchanged. D3D staging rows are
    // aligned and are not guaranteed to be width * 4 bytes.
    Check(frame->WritePixels(height, stride, static_cast<UINT>(bufferSize),
        const_cast<BYTE*>(pixels)), "failed to write PNG pixels");
    Check(frame->Commit(), "failed to commit PNG frame");
    Check(encoder->Commit(), "failed to commit PNG file");
#else
    (void)path; (void)pixels; (void)width; (void)height; (void)stride;
    throw std::runtime_error("PNG writing is only supported on Windows");
#endif
}

} // namespace flash
