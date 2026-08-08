#include "amf_encoder.h"

#if defined(_WIN32) && __has_include(<public/include/core/Factory.h>)
#define FLASH_HAS_AMF 1
#include <Windows.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <public/include/core/Factory.h>
#include <public/include/core/Context.h>
#include <public/include/components/VideoEncoderVCE.h>
using Microsoft::WRL::ComPtr;
#else
#define FLASH_HAS_AMF 0
#endif

namespace flash {

struct AmfEncoder::Impl {
    EncoderConfig config{};
    bool initialized = false;
#if FLASH_HAS_AMF
    HMODULE library = nullptr;
    amf::AMFFactory* factory = nullptr;
    amf::AMFContextPtr context;
    amf::AMFComponentPtr encoder;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> immediate;

    void Reset() {
        if (encoder) { encoder->Drain(); encoder->Terminate(); encoder = nullptr; }
        if (context) { context->Terminate(); context = nullptr; }
        immediate.Reset(); device.Reset(); factory = nullptr;
        if (library) FreeLibrary(library);
        library = nullptr; initialized = false;
    }
#endif
};

AmfEncoder::AmfEncoder() : impl_(std::make_unique<Impl>()) {}
AmfEncoder::~AmfEncoder() {
#if FLASH_HAS_AMF
    impl_->Reset();
#endif
}

bool AmfEncoder::Initialize(const EncoderConfig& config) {
#if FLASH_HAS_AMF
    impl_->Reset(); impl_->config = config;
    impl_->library = LoadLibraryW(L"amfrt64.dll");
    if (!impl_->library) return false;
    auto init = reinterpret_cast<AMFInit_Fn>(GetProcAddress(impl_->library, AMF_INIT_FUNCTION_NAME));
    if (!init || init(AMF_FULL_VERSION, &impl_->factory) != AMF_OK || !impl_->factory) { impl_->Reset(); return false; }
    if (impl_->factory->CreateContext(&impl_->context) != AMF_OK) { impl_->Reset(); return false; }
    D3D_FEATURE_LEVEL featureLevel;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, &impl_->device, &featureLevel, &impl_->immediate)) ||
        impl_->context->InitDX11(impl_->device.Get()) != AMF_OK) { impl_->Reset(); return false; }
    if (impl_->factory->CreateComponent(impl_->context, AMFVideoEncoderVCE_AVC, &impl_->encoder) != AMF_OK) {
        impl_->Reset(); return false;
    }
    const amf::AMFRate frameRate{static_cast<amf_int32>(config.fps), 1};
    const amf::AMFSize frameSize{static_cast<amf_int32>(config.width), static_cast<amf_int32>(config.height)};
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_USAGE, AMF_VIDEO_ENCODER_USAGE_LOW_LATENCY);
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_PROFILE, AMF_VIDEO_ENCODER_PROFILE_HIGH);
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_FRAMERATE, frameRate);
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_FRAMESIZE, frameSize);
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_RATE_CONTROL_METHOD, AMF_VIDEO_ENCODER_RATE_CONTROL_METHOD_CBR);
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_TARGET_BITRATE, static_cast<amf_int64>(config.bitrate));
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_PEAK_BITRATE, static_cast<amf_int64>(config.bitrate));
    impl_->encoder->SetProperty(AMF_VIDEO_ENCODER_IDR_PERIOD, static_cast<amf_int64>(config.fps * 2));
    if (impl_->encoder->Init(amf::AMF_SURFACE_BGRA, config.width, config.height) != AMF_OK) { impl_->Reset(); return false; }
    impl_->initialized = true; return true;
#else
    (void)config; return false;
#endif
}

bool AmfEncoder::EncodeFrame(const FrameData& frame, EncodedPacket& output) {
#if FLASH_HAS_AMF
    if (!impl_->initialized || !frame.data || frame.width != impl_->config.width || frame.height != impl_->config.height) return false;
    amf::AMFSurfacePtr surface;
    if (impl_->context->AllocSurface(amf::AMF_MEMORY_DX11, amf::AMF_SURFACE_BGRA,
            frame.width, frame.height, &surface) != AMF_OK) return false;
    auto* texture = static_cast<ID3D11Texture2D*>(surface->GetPlaneAt(0)->GetNative());
    impl_->immediate->UpdateSubresource(texture, 0, nullptr, frame.data, frame.stride, 0);
    surface->SetPts(frame.timestamp_us * 10);
    surface->SetDuration(10000000LL / impl_->config.fps);
    AMF_RESULT result = impl_->encoder->SubmitInput(surface);
    if (result != AMF_OK && result != AMF_INPUT_FULL) return false;
    amf::AMFDataPtr data;
    result = impl_->encoder->QueryOutput(&data);
    if (result == AMF_REPEAT || !data) return false;
    if (result != AMF_OK) return false;
    amf::AMFBufferPtr buffer(data);
    const auto* begin = static_cast<const uint8_t*>(buffer->GetNative());
    output.data.assign(begin, begin + buffer->GetSize());
    output.timestamp_us = data->GetPts() / 10;
    amf_int64 pictureType = AMF_VIDEO_ENCODER_PICTURE_TYPE_NONE;
    data->GetProperty(AMF_VIDEO_ENCODER_OUTPUT_DATA_TYPE, &pictureType);
    output.isKeyframe = pictureType == AMF_VIDEO_ENCODER_PICTURE_TYPE_IDR || pictureType == AMF_VIDEO_ENCODER_PICTURE_TYPE_I;
    return !output.data.empty();
#else
    (void)frame; (void)output; return false;
#endif
}

void AmfEncoder::Flush() {
#if FLASH_HAS_AMF
    if (impl_->encoder) impl_->encoder->Drain();
#endif
}

} // namespace flash
