#include "smart_render.h"
#include "../color_space.h"

#ifdef _WIN32
#include <Windows.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <propvarutil.h>
#include <strmif.h>
#include <wrl/client.h>

#include <algorithm>
#include <stdexcept>
#include <vector>

using Microsoft::WRL::ComPtr;
#endif

namespace flash {

#ifdef _WIN32
namespace {

bool TraceFailure(const char* stage, HRESULT result = E_FAIL) {
    std::fprintf(stderr, "smart render failed at %s (HRESULT %08lx)\n", stage,
        static_cast<unsigned long>(result));
    return false;
}

void CopyAttributeIfPresent(IMFAttributes* source, IMFAttributes* target, const GUID& key) {
    PROPVARIANT value;
    PropVariantInit(&value);
    if (SUCCEEDED(source->GetItem(key, &value))) target->SetItem(key, value);
    PropVariantClear(&value);
}

struct EncodedHead {
    std::vector<ComPtr<IMFSample>> samples;
    bool firstSampleIsClean = false;
};

bool PullEncoderOutput(IMFTransform* encoder, const MFT_OUTPUT_STREAM_INFO& outputInfo,
                       EncodedHead& head) {
    for (;;) {
        MFT_OUTPUT_DATA_BUFFER output{};
        ComPtr<IMFSample> allocated;
        if (!(outputInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
            if (FAILED(MFCreateSample(&allocated))) return false;
            ComPtr<IMFMediaBuffer> buffer;
            const DWORD capacity = (std::max)(outputInfo.cbSize,
                static_cast<DWORD>(1024u * 1024u));
            if (FAILED(MFCreateMemoryBuffer(capacity, &buffer)) ||
                FAILED(allocated->AddBuffer(buffer.Get()))) return false;
            output.pSample = allocated.Get();
        }

        DWORD status = 0;
        const HRESULT result = encoder->ProcessOutput(0, 1, &output, &status);
        if (output.pEvents) output.pEvents->Release();
        if (result == MF_E_TRANSFORM_NEED_MORE_INPUT) return true;
        if (FAILED(result) || !output.pSample) return false;

        ComPtr<IMFSample> sample;
        if (outputInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) {
            sample.Attach(output.pSample);
        } else {
            sample = allocated;
        }
        if (head.samples.empty()) {
            UINT32 clean = FALSE;
            head.firstSampleIsClean =
                SUCCEEDED(sample->GetUINT32(MFSampleExtension_CleanPoint, &clean)) && clean;
        }
        head.samples.push_back(std::move(sample));
    }
}

bool SubmitFrame(IMFTransform* encoder, const MFT_OUTPUT_STREAM_INFO& outputInfo,
                 IMFSample* sample, EncodedHead& head) {
    for (;;) {
        const HRESULT result = encoder->ProcessInput(0, sample, 0);
        if (SUCCEEDED(result)) return PullEncoderOutput(encoder, outputInfo, head);
        if (result != MF_E_NOTACCEPTING || !PullEncoderOutput(encoder, outputInfo, head))
            return false;
    }
}

bool ConfigureEncoder(IMFMediaType* sourceType, IMFMediaType* decodedType,
                      ComPtr<IMFTransform>& encoder, MFT_OUTPUT_STREAM_INFO& outputInfo,
                      uint32_t targetBitrate) {
    ComPtr<IMFMediaType> encodedType;
    if (FAILED(MFCreateMediaType(&encodedType)) ||
        FAILED(encodedType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
        FAILED(encodedType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264))) return false;

    // Copy encoder settings, but not source-specific SPS/PPS or MP4 sample-entry
    // blobs. Those describe the old encoder and make a fresh MFT reject the type.
    const GUID copiedAttributes[] = {
        MF_MT_FRAME_SIZE,
        MF_MT_FRAME_RATE,
        MF_MT_PIXEL_ASPECT_RATIO,
        MF_MT_INTERLACE_MODE,
        MF_MT_AVG_BITRATE,
        MF_MT_MPEG2_PROFILE,
        MF_MT_MPEG2_LEVEL,
    };
    for (const GUID& key : copiedAttributes)
        CopyAttributeIfPresent(sourceType, encodedType.Get(), key);
    // An MP4's native H.264 type carries no MF_MT_AVG_BITRATE, so the copy
    // above usually finds nothing and the encoder falls back to its own
    // default - measured at roughly twice the source rate. The caller measures
    // the real rate off the source samples; prefer it when we have it.
    if (targetBitrate) encodedType->SetUINT32(MF_MT_AVG_BITRATE, targetBitrate);
    UINT32 width = 0, height = 0, rateNumerator = 0, rateDenominator = 0;
    if (FAILED(MFGetAttributeSize(encodedType.Get(), MF_MT_FRAME_SIZE, &width, &height)) ||
        !width || !height ||
        FAILED(MFGetAttributeRatio(encodedType.Get(), MF_MT_FRAME_RATE,
            &rateNumerator, &rateDenominator)) || !rateNumerator || !rateDenominator)
        return TraceFailure("required source encoder attributes");
    TagBt709Limited(encodedType.Get());
    TagBt709Limited(decodedType);

    MFT_REGISTER_TYPE_INFO inputInfo{MFMediaType_Video, MFVideoFormat_NV12};
    MFT_REGISTER_TYPE_INFO outputTypeInfo{MFMediaType_Video, MFVideoFormat_H264};
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    const HRESULT enumerate = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER,
        &inputInfo, &outputTypeInfo, &activates, &count);
    if (FAILED(enumerate)) return TraceFailure("enumerate encoder", enumerate);

    HRESULT lastTypeResult = E_FAIL;
    for (UINT32 i = 0; i < count && !encoder; ++i) {
        ComPtr<IMFTransform> candidate;
        if (FAILED(activates[i]->ActivateObject(IID_PPV_ARGS(&candidate)))) continue;
        lastTypeResult = candidate->SetOutputType(0, encodedType.Get(), 0);
        if (FAILED(lastTypeResult)) continue;
        lastTypeResult = candidate->SetInputType(0, decodedType, 0);
        if (FAILED(lastTypeResult)) continue;
        encoder = std::move(candidate);
    }
    for (UINT32 i = 0; i < count; ++i) activates[i]->Release();
    if (activates) CoTaskMemFree(activates);
    if (!encoder) return TraceFailure("set encoder media types", lastTypeResult);

    ComPtr<ICodecAPI> codec;
    if (FAILED(encoder.As(&codec))) return TraceFailure("query encoder codec API");
    VARIANT value;
    VariantInit(&value);
    value.vt = VT_BOOL;
    value.boolVal = VARIANT_TRUE;
    const HRESULT lowLatency = codec->SetValue(&CODECAPI_AVLowLatencyMode, &value);
    VariantClear(&value);
    if (FAILED(lowLatency)) return TraceFailure("set encoder low latency", lowLatency);

    // MF_MT_AVG_BITRATE on the media type is not enough on its own - the
    // encoder ignores it and picks its own rate, measured at roughly twice the
    // source. Both existing encoders in this package set the rate a second time
    // through ICodecAPI for exactly this reason; do the same here.
    if (targetBitrate) {
        VariantInit(&value);
        value.vt = VT_UI4;
        value.ulVal = eAVEncCommonRateControlMode_CBR;
        // Both calls return S_OK and the currently selected sync MFT still
        // encodes the head at roughly four times this rate. Kept because it is
        // what the other two encoders in this package do, it costs nothing, and
        // it will take effect if the head ever moves to the hardware encoder.
        codec->SetValue(&CODECAPI_AVEncCommonRateControlMode, &value);
        value.ulVal = targetBitrate;
        codec->SetValue(&CODECAPI_AVEncCommonMeanBitRate, &value);
        VariantClear(&value);
    }

    if (FAILED(encoder->GetOutputStreamInfo(0, &outputInfo)) ||
        FAILED(encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) ||
        FAILED(encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)))
        return TraceFailure("start encoder");
    return true;
}

bool ForceNextFrameToIdr(IMFTransform* encoder) {
    ComPtr<ICodecAPI> codec;
    if (FAILED(encoder->QueryInterface(IID_PPV_ARGS(&codec)))) return false;
    VARIANT value;
    VariantInit(&value);
    value.vt = VT_UI4;
    value.ulVal = 1;
    const HRESULT result = codec->SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &value);
    VariantClear(&value);
    return SUCCEEDED(result);
}

void SeekReader(IMFSourceReader* reader, LONGLONG ticks) {
    PROPVARIANT position;
    PropVariantInit(&position);
    position.vt = VT_I8;
    position.hVal.QuadPart = ticks;
    const HRESULT result = reader->SetCurrentPosition(GUID_NULL, position);
    PropVariantClear(&position);
    if (FAILED(result)) throw std::runtime_error("smart-render decoder seek failed");
}

} // namespace

// One pass over every video sample. Throws nothing: a stream that stops early
// yields whatever it managed to read, which is still a usable keyframe list.
VideoScan ScanVideoStream(IMFSourceReader* reader, DWORD videoStream) {
    VideoScan scan;
    if (!reader) return scan;
    for (;;) {
        DWORD actual = 0, flags = 0;
        LONGLONG time = 0;
        ComPtr<IMFSample> sample;
        if (FAILED(reader->ReadSample(videoStream, 0, &actual, &flags, &time, &sample))) break;
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
        if (flags & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED |
                     MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED)) break;
        if (!sample) continue;
        DWORD sampleBytes = 0;
        if (SUCCEEDED(sample->GetTotalLength(&sampleBytes))) scan.bytes += sampleBytes;
        scan.lastTimeUs = time / 10;
        UINT32 cleanPoint = FALSE;
        if (SUCCEEDED(sample->GetUINT32(MFSampleExtension_CleanPoint, &cleanPoint)) && cleanPoint)
            scan.keyframesUs.push_back(time / 10);
    }
    return scan;
}

VideoScan ScanClipVideo(const std::string& path) {
    VideoScan scan;
    if (path.empty()) return scan;

    // This is the one entry point here that opens its own reader rather than
    // borrowing the trimmer's, so it has to start Media Foundation itself.
    // Without this the reader never opens and the scan comes back empty.
    struct MfScope {
        MfScope() {
            apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            started = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_FULL));
        }
        ~MfScope() {
            if (started) MFShutdown();
            if (SUCCEEDED(apartment)) CoUninitialize();
        }
        HRESULT apartment = E_FAIL;
        bool started = false;
    } mf;
    if (!mf.started) return scan;
    const int wideLength = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(),
        static_cast<int>(path.size()), nullptr, 0);
    if (wideLength <= 0) return scan;
    std::wstring wide(static_cast<size_t>(wideLength), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(),
        static_cast<int>(path.size()), wide.data(), wideLength);

    // Converters off: this only reads sample metadata, so decoding would be
    // pure waste on what is already a full pass over the file.
    ComPtr<IMFAttributes> attributes;
    if (FAILED(MFCreateAttributes(&attributes, 2))) return scan;
    attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, FALSE);
    attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, TRUE);

    ComPtr<IMFSourceReader> reader;
    if (FAILED(MFCreateSourceReaderFromURL(wide.c_str(), attributes.Get(), &reader))) return scan;
    reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE);
    if (FAILED(reader->SetStreamSelection(
            static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), TRUE))) return scan;
    return ScanVideoStream(reader.Get(),
        static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM));
}

bool RenderHeadFragment(IMFSourceReader* reader, IMFSinkWriter* writer,
                        DWORD videoStream, DWORD writerStream,
                        const SmartRenderPlan& plan, IMFMediaType* sourceType,
                        uint32_t targetBitrate) {
    if (!reader || !writer || !sourceType || !plan.needsHeadEncode ||
        plan.headEndUs <= plan.headStartUs) return false;

    try {
        ComPtr<IMFMediaType> requestedType;
        if (FAILED(MFCreateMediaType(&requestedType)) ||
            FAILED(requestedType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
            FAILED(requestedType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12)))
            return TraceFailure("create decoder media type");
        const GUID decoderAttributes[] = {
            MF_MT_FRAME_SIZE,
            MF_MT_FRAME_RATE,
            MF_MT_PIXEL_ASPECT_RATIO,
            MF_MT_INTERLACE_MODE,
        };
        for (const GUID& key : decoderAttributes)
            CopyAttributeIfPresent(sourceType, requestedType.Get(), key);
        TagBt709Limited(requestedType.Get());
        HRESULT result = reader->SetStreamSelection(
            static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE);
        if (FAILED(result)) return TraceFailure("deselect decoder streams", result);
        result = reader->SetStreamSelection(videoStream, TRUE);
        if (FAILED(result)) return TraceFailure("select decoder video", result);
        result = reader->SetCurrentMediaType(videoStream, nullptr, requestedType.Get());
        if (FAILED(result)) return TraceFailure("set decoder media type", result);

        ComPtr<IMFMediaType> decodedType;
        if (FAILED(reader->GetCurrentMediaType(videoStream, &decodedType)))
            return TraceFailure("get decoder media type");
        TagBt709Limited(decodedType.Get());

        ComPtr<IMFTransform> encoder;
        MFT_OUTPUT_STREAM_INFO outputInfo{};
        if (!ConfigureEncoder(sourceType, decodedType.Get(), encoder, outputInfo, targetBitrate) ||
            !ForceNextFrameToIdr(encoder.Get())) return TraceFailure("configure encoder or force IDR");

        const LONGLONG startTicks = plan.headStartUs * 10;
        const LONGLONG endTicks = plan.headEndUs * 10;
        SeekReader(reader, startTicks);

        EncodedHead head;
        bool submittedFrame = false;
        for (;;) {
            DWORD actualStream = 0;
            DWORD flags = 0;
            LONGLONG time = 0;
            ComPtr<IMFSample> sample;
            if (FAILED(reader->ReadSample(videoStream, 0, &actualStream, &flags, &time, &sample)))
                return TraceFailure("read decoded frame");
            if (flags & MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED)
                return TraceFailure("decoder native media type changed");
            if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
            if (!sample || time < startTicks) continue;
            if (time >= endTicks) break;

            if (FAILED(sample->SetSampleTime(time - startTicks)))
                return TraceFailure("rebase decoded frame");
            if (!SubmitFrame(encoder.Get(), outputInfo, sample.Get(), head))
                return TraceFailure("encode decoded frame");
            submittedFrame = true;
        }
        if (!submittedFrame ||
            FAILED(encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)) ||
            FAILED(encoder->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)) ||
            !PullEncoderOutput(encoder.Get(), outputInfo, head) || head.samples.empty() ||
            !head.firstSampleIsClean) return TraceFailure("drain or validate encoded head");

        // Encoding is transactional up to this point. Only publish the head to
        // the output after every frame and the required first IDR are present.
        for (size_t i = 0; i < head.samples.size(); ++i) {
            if (i == 0) {
                if (FAILED(head.samples[i]->SetUINT32(MFSampleExtension_CleanPoint, TRUE)) ||
                    FAILED(head.samples[i]->SetUINT32(MFSampleExtension_Discontinuity, TRUE)))
                    return false;
            }
            const HRESULT written = writer->WriteSample(writerStream, head.samples[i].Get());
            if (FAILED(written))
                throw std::runtime_error("smart-render head write failed");
        }
        encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        return true;
    } catch (...) {
        throw;
    }
}

#endif

} // namespace flash
