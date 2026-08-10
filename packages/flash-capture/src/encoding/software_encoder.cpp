#include "software_encoder.h"

#include "../color_space.h"

#ifdef _WIN32
#include <Windows.h>
#include <strmif.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstring>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

struct SoftwareEncoder::Impl {
    EncoderConfig config{};
    bool initialized = false;
#ifdef _WIN32
    ComPtr<IMFTransform> transform;
    MFT_OUTPUT_STREAM_INFO outputInfo{};
    uint64_t frameIndex = 0;
    bool mfStarted = false;

    void Reset() {
        if (transform) {
            transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
        transform.Reset();
        if (mfStarted) MFShutdown();
        mfStarted = false;
        initialized = false;
    }
#endif
};

SoftwareEncoder::SoftwareEncoder() : impl_(std::make_unique<Impl>()) {}
SoftwareEncoder::~SoftwareEncoder() {
#ifdef _WIN32
    impl_->Reset();
#endif
}

#ifdef _WIN32
static bool SetSizeAndRate(IMFMediaType* type, const EncoderConfig& c) {
    TagBt709Limited(type);
    return SUCCEEDED(MFSetAttributeSize(type, MF_MT_FRAME_SIZE, c.width, c.height)) &&
           SUCCEEDED(MFSetAttributeRatio(type, MF_MT_FRAME_RATE, c.fps, 1)) &&
           SUCCEEDED(MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1)) &&
           SUCCEEDED(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
}

static void BgraToNv12(const FrameData& frame, uint8_t* dst, uint32_t width, uint32_t height) {
    auto clamp = [](int v) { return static_cast<uint8_t>(std::clamp(v, 0, 255)); };
    uint8_t* yPlane = dst;
    uint8_t* uvPlane = dst + static_cast<size_t>(width) * height;
    for (uint32_t y = 0; y < height; ++y) {
        const uint32_t sy = static_cast<uint32_t>(static_cast<uint64_t>(y) * frame.height / height);
        const uint8_t* row = frame.data + static_cast<size_t>(sy) * frame.stride;
        for (uint32_t x = 0; x < width; ++x) {
            const uint32_t sx = static_cast<uint32_t>(static_cast<uint64_t>(x) * frame.width / width);
            const int b = row[sx * 4], g = row[sx * 4 + 1], r = row[sx * 4 + 2];
            yPlane[static_cast<size_t>(y) * width + x] = clamp(Bt709Y(r, g, b));
        }
    }
    for (uint32_t y = 0; y < height; y += 2) {
        const uint32_t sy0 = static_cast<uint32_t>(static_cast<uint64_t>(y) * frame.height / height);
        const uint32_t sy1 = static_cast<uint32_t>(static_cast<uint64_t>(std::min(y + 1, height - 1)) * frame.height / height);
        const uint8_t* row0 = frame.data + static_cast<size_t>(sy0) * frame.stride;
        const uint8_t* row1 = frame.data + static_cast<size_t>(sy1) * frame.stride;
        for (uint32_t x = 0; x < width; x += 2) {
            int sumU = 0, sumV = 0;
            for (uint32_t dy = 0; dy < 2; ++dy) for (uint32_t dx = 0; dx < 2; ++dx) {
                const uint32_t ox = std::min(x + dx, width - 1);
                const uint32_t sx = static_cast<uint32_t>(static_cast<uint64_t>(ox) * frame.width / width);
                const uint8_t* p = (dy ? row1 : row0) + sx * 4;
                const int b = p[0], g = p[1], r = p[2];
                sumU += Bt709U(r, g, b);
                sumV += Bt709V(r, g, b);
            }
            const size_t uv = static_cast<size_t>(y / 2) * width + x;
            uvPlane[uv] = clamp(sumU / 4);
            if (x + 1 < width) uvPlane[uv + 1] = clamp(sumV / 4);
        }
    }
}
#endif

bool SoftwareEncoder::Initialize(const EncoderConfig& config) {
#ifdef _WIN32
    impl_->Reset();
    impl_->config = config;
    if (!config.width || !config.height || !config.fps || (config.width & 1) || (config.height & 1)) return false;
    if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) return false;
    impl_->mfStarted = true;

    MFT_REGISTER_TYPE_INFO inputInfo{MFMediaType_Video, MFVideoFormat_NV12};
    MFT_REGISTER_TYPE_INFO outputInfo{MFMediaType_Video, MFVideoFormat_H264};
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_SORTANDFILTER,
                           &inputInfo, &outputInfo, &activates, &count);
    if (FAILED(hr) || !count) { if (activates) CoTaskMemFree(activates); impl_->Reset(); return false; }
    for (UINT32 i = 0; i < count && !impl_->transform; ++i)
        activates[i]->ActivateObject(IID_PPV_ARGS(&impl_->transform));
    for (UINT32 i = 0; i < count; ++i) activates[i]->Release();
    CoTaskMemFree(activates);
    if (!impl_->transform) { impl_->Reset(); return false; }

    ComPtr<IMFMediaType> outType;
    MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    outType->SetUINT32(MF_MT_AVG_BITRATE, config.bitrate);
    outType->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
    SetSizeAndRate(outType.Get(), config);
    hr = impl_->transform->SetOutputType(0, outType.Get(), 0);

    ComPtr<IMFMediaType> inType;
    MFCreateMediaType(&inType);
    inType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    inType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    SetSizeAndRate(inType.Get(), config);
    if (SUCCEEDED(hr)) hr = impl_->transform->SetInputType(0, inType.Get(), 0);
    if (FAILED(hr)) { impl_->Reset(); return false; }

    ComPtr<ICodecAPI> codec;
    if (SUCCEEDED(impl_->transform.As(&codec))) {
        VARIANT v; VariantInit(&v);
        v.vt = VT_UI4; v.ulVal = config.bitrate; codec->SetValue(&CODECAPI_AVEncCommonMeanBitRate, &v);
        v.vt = VT_BOOL; v.boolVal = VARIANT_TRUE; codec->SetValue(&CODECAPI_AVLowLatencyMode, &v);
        v.vt = VT_UI4; v.ulVal = eAVEncCommonRateControlMode_CBR; codec->SetValue(&CODECAPI_AVEncCommonRateControlMode, &v);
        v.vt = VT_UI4; v.ulVal = config.fps * 2; codec->SetValue(&CODECAPI_AVEncMPVGOPSize, &v);
        v.vt = VT_UI4; v.ulVal = 80; codec->SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &v);
        VariantClear(&v);
    }
    if (FAILED(impl_->transform->GetOutputStreamInfo(0, &impl_->outputInfo)) ||
        FAILED(impl_->transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) ||
        FAILED(impl_->transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))) {
        impl_->Reset(); return false;
    }
    impl_->frameIndex = 0;
    impl_->initialized = true;
    return true;
#else
    (void)config; return false;
#endif
}

bool SoftwareEncoder::EncodeFrame(const FrameData& frame, std::vector<EncodedPacket>& output) {
#ifdef _WIN32
    if (!impl_->initialized || !frame.data || !frame.width || !frame.height) return false;
    const DWORD bytes = impl_->config.width * impl_->config.height * 3 / 2;
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(MFCreateMemoryBuffer(bytes, &buffer))) return false;
    BYTE* data = nullptr; DWORD maxLength = 0;
    if (FAILED(buffer->Lock(&data, &maxLength, nullptr))) return false;
    BgraToNv12(frame, data, impl_->config.width, impl_->config.height);
    buffer->Unlock(); buffer->SetCurrentLength(bytes);
    ComPtr<IMFSample> sample;
    MFCreateSample(&sample); sample->AddBuffer(buffer.Get());
    const LONGLONG duration = 10000000LL / impl_->config.fps;
    const LONGLONG timestamp = frame.timestamp_us >= 0 ? frame.timestamp_us * 10 : impl_->frameIndex * duration;
    sample->SetSampleTime(timestamp); sample->SetSampleDuration(duration);
    HRESULT hr = impl_->transform->ProcessInput(0, sample.Get(), 0);
    if (FAILED(hr)) return false;
    ++impl_->frameIndex;

    for (;;) {
        MFT_OUTPUT_DATA_BUFFER out{}; ComPtr<IMFSample> outSample;
        if (!(impl_->outputInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
            MFCreateSample(&outSample); ComPtr<IMFMediaBuffer> outBuffer;
            MFCreateMemoryBuffer(std::max<DWORD>(impl_->outputInfo.cbSize, 1024 * 1024), &outBuffer);
            outSample->AddBuffer(outBuffer.Get()); out.pSample = outSample.Get();
        }
        DWORD status = 0; hr = impl_->transform->ProcessOutput(0, 1, &out, &status);
        if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) break;
        if (FAILED(hr) || !out.pSample) { if (out.pEvents) out.pEvents->Release(); return false; }
        const bool releaseSample = (impl_->outputInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) != 0;
        ComPtr<IMFMediaBuffer> contiguous; hr = out.pSample->ConvertToContiguousBuffer(&contiguous);
        if (out.pEvents) out.pEvents->Release(); if (FAILED(hr)) { if (releaseSample) out.pSample->Release(); return false; }
        BYTE* encoded = nullptr; DWORD length = 0; contiguous->Lock(&encoded, nullptr, &length);
        EncodedPacket packet; packet.data.assign(encoded, encoded + length); contiguous->Unlock();
        LONGLONG sampleTime = timestamp; out.pSample->GetSampleTime(&sampleTime); packet.timestamp_us = sampleTime / 10;
        UINT32 clean = FALSE; packet.isKeyframe = SUCCEEDED(out.pSample->GetUINT32(MFSampleExtension_CleanPoint, &clean)) && clean;
        if (!packet.data.empty()) output.push_back(std::move(packet));
        if (releaseSample) out.pSample->Release();
    }
    return true;
#else
    (void)frame; (void)output; return false;
#endif
}

void SoftwareEncoder::Flush() {
#ifdef _WIN32
    if (!impl_->transform) return;
    impl_->transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    impl_->transform->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
#endif
}

} // namespace flash
