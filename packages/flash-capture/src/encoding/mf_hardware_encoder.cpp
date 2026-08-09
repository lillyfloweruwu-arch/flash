#include "mf_hardware_encoder.h"
#ifdef _WIN32
#include <Windows.h>
#include <codecapi.h>
#include <strmif.h>
#include <algorithm>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

struct MfHardwareEncoder::Impl {
    EncoderConfig config{}; std::string name = "Hardware H.264 (Media Foundation)"; bool initialized = false;
#ifdef _WIN32
    ComPtr<IMFTransform> transform; ComPtr<IMFMediaEventGenerator> events;
    ComPtr<IMFDXGIDeviceManager> manager; UINT resetToken = 0; MFT_OUTPUT_STREAM_INFO outputInfo{};
    ComPtr<ID3D11DeviceContext> context;
    bool mfStarted = false; uint64_t frameIndex = 0;
    void Reset() {
        if (transform) { transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0); transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0); }
        events.Reset(); transform.Reset(); manager.Reset(); context.Reset(); initialized = false;
        if (mfStarted) MFShutdown(); mfStarted = false;
    }
#endif
};

MfHardwareEncoder::MfHardwareEncoder() : impl_(std::make_unique<Impl>()) {}
MfHardwareEncoder::~MfHardwareEncoder() {
#ifdef _WIN32
    impl_->Reset();
#endif
}
std::string MfHardwareEncoder::GetName() const { return impl_->name; }

#ifdef _WIN32
static bool ConfigureType(IMFMediaType* type, const GUID& subtype, const EncoderConfig& c) {
    return SUCCEEDED(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) && SUCCEEDED(type->SetGUID(MF_MT_SUBTYPE, subtype)) &&
        SUCCEEDED(MFSetAttributeSize(type, MF_MT_FRAME_SIZE, c.width, c.height)) &&
        SUCCEEDED(MFSetAttributeRatio(type, MF_MT_FRAME_RATE, c.fps, 1)) &&
        SUCCEEDED(MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1)) &&
        SUCCEEDED(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
}

static bool AppendOutput(IMFTransform* transform, const MFT_OUTPUT_STREAM_INFO& info, std::vector<EncodedPacket>& output) {
    for (;;) {
        MFT_OUTPUT_DATA_BUFFER out{}; ComPtr<IMFSample> allocated;
        if (!(info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
            if (FAILED(MFCreateSample(&allocated))) return false;
            ComPtr<IMFMediaBuffer> bytes;
            if (FAILED(MFCreateMemoryBuffer((std::max<DWORD>)(info.cbSize, 1024u * 1024u), &bytes)) || FAILED(allocated->AddBuffer(bytes.Get()))) return false;
            out.pSample = allocated.Get();
        }
        DWORD status = 0; HRESULT hr = transform->ProcessOutput(0, 1, &out, &status);
        if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return true;
        if (FAILED(hr) || !out.pSample) { if (out.pEvents) out.pEvents->Release(); return false; }
        const bool releaseSample = (info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) != 0;
        ComPtr<IMFMediaBuffer> bytes; hr = out.pSample->ConvertToContiguousBuffer(&bytes);
        if (out.pEvents) out.pEvents->Release(); if (FAILED(hr)) { if (releaseSample) out.pSample->Release(); return false; }
        BYTE* data = nullptr; DWORD length = 0; if (FAILED(bytes->Lock(&data, nullptr, &length))) return false;
        EncodedPacket packet; packet.data.assign(data, data + length); bytes->Unlock();
        LONGLONG time = 0; out.pSample->GetSampleTime(&time); packet.timestamp_us = time / 10;
        UINT32 clean = FALSE; packet.isKeyframe = SUCCEEDED(out.pSample->GetUINT32(MFSampleExtension_CleanPoint, &clean)) && clean;
        if (!packet.data.empty()) output.push_back(std::move(packet));
        if (releaseSample) out.pSample->Release();
    }
}
#endif

bool MfHardwareEncoder::Initialize(const EncoderConfig& config) {
#ifdef _WIN32
    impl_->Reset(); impl_->config = config;
    if (!config.device || !config.width || !config.height || !config.fps || (config.width & 1) || (config.height & 1)) return false;
    if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) return false; impl_->mfStarted = true;
    MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12}, output{MFMediaType_Video, MFVideoFormat_H264};
    IMFActivate** activates = nullptr; UINT32 count = 0;
    HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, &input, &output, &activates, &count);
    for (UINT32 i = 0; SUCCEEDED(hr) && i < count && !impl_->transform; ++i) {
        ComPtr<IMFTransform> candidate;
        if (FAILED(activates[i]->ActivateObject(IID_PPV_ARGS(&candidate)))) continue;
        UINT32 async = FALSE, aware = FALSE;
        ComPtr<IMFAttributes> attrs;
        if (FAILED(candidate->GetAttributes(&attrs)) || FAILED(attrs->GetUINT32(MF_TRANSFORM_ASYNC, &async)) || !async ||
            FAILED(attrs->GetUINT32(MF_SA_D3D11_AWARE, &aware)) || !aware || FAILED(attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE))) continue;
        WCHAR* friendly = nullptr; UINT32 chars = 0;
        if (SUCCEEDED(activates[i]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &friendly, &chars))) {
            int n = WideCharToMultiByte(CP_UTF8, 0, friendly, -1, nullptr, 0, nullptr, nullptr);
            std::string utf8(n ? n : 1, '\0'); if (n > 1) WideCharToMultiByte(CP_UTF8, 0, friendly, -1, utf8.data(), n, nullptr, nullptr);
            if (!utf8.empty() && utf8.back() == '\0') utf8.pop_back();
            impl_->name = std::move(utf8); CoTaskMemFree(friendly);
        }
        impl_->transform = candidate;
    }
    for (UINT32 i = 0; i < count; ++i) activates[i]->Release(); if (activates) CoTaskMemFree(activates);
    if (!impl_->transform || FAILED(MFCreateDXGIDeviceManager(&impl_->resetToken, &impl_->manager)) ||
        FAILED(impl_->manager->ResetDevice(config.device, impl_->resetToken)) ||
        FAILED(impl_->transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(impl_->manager.Get())))) { impl_->Reset(); return false; }
    config.device->GetImmediateContext(&impl_->context);
    ComPtr<IMFMediaType> outType, inType; MFCreateMediaType(&outType); MFCreateMediaType(&inType);
    ConfigureType(outType.Get(), MFVideoFormat_H264, config); outType->SetUINT32(MF_MT_AVG_BITRATE, config.bitrate); outType->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
    ConfigureType(inType.Get(), MFVideoFormat_NV12, config);
    if (FAILED(impl_->transform->SetOutputType(0, outType.Get(), 0)) || FAILED(impl_->transform->SetInputType(0, inType.Get(), 0))) { impl_->Reset(); return false; }
    ComPtr<ICodecAPI> codec;
    if (SUCCEEDED(impl_->transform.As(&codec))) {
        VARIANT v; VariantInit(&v); v.vt = VT_UI4; v.ulVal = config.bitrate; codec->SetValue(&CODECAPI_AVEncCommonMeanBitRate, &v);
        v.ulVal = config.fps * 2; codec->SetValue(&CODECAPI_AVEncMPVGOPSize, &v); v.ulVal = 80; codec->SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &v);
        v.vt = VT_BOOL; v.boolVal = VARIANT_TRUE; codec->SetValue(&CODECAPI_AVLowLatencyMode, &v); VariantClear(&v);
    }
    if (FAILED(impl_->transform.As(&impl_->events)) || FAILED(impl_->transform->GetOutputStreamInfo(0, &impl_->outputInfo)) ||
        FAILED(impl_->transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) || FAILED(impl_->transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))) { impl_->Reset(); return false; }
    impl_->initialized = true; impl_->frameIndex = 0; return true;
#else
    (void)config; return false;
#endif
}

bool MfHardwareEncoder::EncodeFrame(const FrameData& frame, std::vector<EncodedPacket>& output) {
#ifdef _WIN32
    if (!impl_->initialized || !frame.texture || frame.device != impl_->config.device || frame.width != impl_->config.width || frame.height != impl_->config.height) return false;
    bool submitted = false;
    for (int i = 0; i < 32; ++i) {
        ComPtr<IMFMediaEvent> event; HRESULT hr = impl_->events->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
        if (hr == MF_E_NO_EVENTS_AVAILABLE) break; if (FAILED(hr)) return false;
        MediaEventType type = MEUnknown; event->GetType(&type);
        if (type == METransformHaveOutput) { if (!AppendOutput(impl_->transform.Get(), impl_->outputInfo, output)) return false; }
        else if (type == METransformNeedInput && !submitted) {
            D3D11_TEXTURE2D_DESC desc{}; frame.texture->GetDesc(&desc);
            ComPtr<ID3D11Texture2D> inputTexture; ComPtr<IMFMediaBuffer> buffer; ComPtr<IMFSample> sample;
            if (!impl_->context || FAILED(impl_->config.device->CreateTexture2D(&desc, nullptr, &inputTexture))) return false;
            impl_->context->CopyResource(inputTexture.Get(), frame.texture);
            if (FAILED(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), inputTexture.Get(), 0, FALSE, &buffer)) ||
                FAILED(MFCreateSample(&sample)) || FAILED(sample->AddBuffer(buffer.Get()))) return false;
            const LONGLONG duration = 10000000LL / impl_->config.fps, timestamp = frame.timestamp_us * 10;
            sample->SetSampleTime(timestamp); sample->SetSampleDuration(duration);
            if (FAILED(impl_->transform->ProcessInput(0, sample.Get(), 0))) return false;
            submitted = true; ++impl_->frameIndex;
        }
    }
    return submitted;
#else
    (void)frame; (void)output; return false;
#endif
}

void MfHardwareEncoder::Flush() {
#ifdef _WIN32
    if (!impl_->transform) return; impl_->transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0); impl_->transform->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
#endif
}

} // namespace flash
