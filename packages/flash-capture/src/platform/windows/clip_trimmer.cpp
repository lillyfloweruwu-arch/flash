#include "media_output.h"
#include "audio_track_order.h"
#include "../../core/clip_trimmer.h"
#include "../../core/smart_render.h"
#include "color_space.h"
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <limits>
#include <stdexcept>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <propvarutil.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

#ifdef _WIN32
bool RenderHeadFragment(IMFSourceReader* reader, IMFSinkWriter* writer,
    DWORD videoStream, DWORD writerStream, const SmartRenderPlan& plan,
    IMFMediaType* sourceType, uint32_t targetBitrate);
VideoScan ScanVideoStream(IMFSourceReader* reader, DWORD videoStream);

namespace {

std::wstring ToWide(const std::string& value) {
    if (value.empty()) return {};
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0);
    if (!count) throw std::runtime_error("clip path is not valid UTF-8");
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), count);
    return result;
}

void Check(HRESULT hr, const char* operation) {
    if (FAILED(hr)) throw std::runtime_error(std::string(operation) + " failed (HRESULT " +
        std::to_string(static_cast<unsigned long>(hr)) + ")");
}

bool SamePath(const std::filesystem::path& left, const std::filesystem::path& right) {
    const auto a = std::filesystem::absolute(left).lexically_normal().wstring();
    const auto b = std::filesystem::absolute(right).lexically_normal().wstring();
    return CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(),
        static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}

struct MfScope {
    MfScope() {
        apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(apartment) && apartment != RPC_E_CHANGED_MODE) Check(apartment, "CoInitializeEx");
        Check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "MFStartup");
        started = true;
    }
    ~MfScope() {
        if (started) MFShutdown();
        if (SUCCEEDED(apartment)) CoUninitialize();
    }
    HRESULT apartment = E_FAIL;
    bool started = false;
};

struct Stream {
    DWORD reader = 0;
    DWORD writer = 0;
    GUID major{};
    ComPtr<IMFSample> sample;
    LONGLONG time = 0;
    bool ended = false;
};

void ReadNext(IMFSourceReader* reader, Stream& stream) {
    stream.sample.Reset();
    while (!stream.ended) {
        DWORD actual = 0, flags = 0;
        LONGLONG time = 0;
        ComPtr<IMFSample> sample;
        Check(reader->ReadSample(stream.reader, 0, &actual, &flags, &time, &sample),
            "IMFSourceReader::ReadSample");
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { stream.ended = true; return; }
        if (flags & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED |
            MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED))
            throw std::runtime_error("input media type changed while trimming");
        if (!sample) continue;
        stream.sample = std::move(sample);
        stream.time = time;
        return;
    }
}

void SeekReader(IMFSourceReader* reader, LONGLONG ticks) {
    PROPVARIANT position;
    PropVariantInit(&position);
    position.vt = VT_I8;
    position.hVal.QuadPart = ticks;
    const HRESULT result = reader->SetCurrentPosition(GUID_NULL, position);
    PropVariantClear(&position);
    Check(result, "IMFSourceReader::SetCurrentPosition");
}

} // namespace
#endif

ClipMetadata TrimClip(const std::string& inputPath, const std::string& outputPath,
    int64_t startUs, int64_t endUs) {
    if (inputPath.empty() || outputPath.empty()) throw std::invalid_argument("clip paths must not be empty");
    if (startUs < 0 || endUs <= startUs) throw std::invalid_argument("trim range must have a non-negative start and end after start");
    if (startUs > (std::numeric_limits<int64_t>::max)() / 10 ||
        endUs > (std::numeric_limits<int64_t>::max)() / 10)
        throw std::invalid_argument("trim range is too large");

#ifdef _WIN32
    const auto input = std::filesystem::u8path(inputPath);
    const auto output = std::filesystem::u8path(outputPath);
    if (!std::filesystem::is_regular_file(input)) throw std::invalid_argument("input clip does not exist");
    if (SamePath(input, output)) throw std::invalid_argument("input and output clips must be different files");
    if (!output.parent_path().empty()) std::filesystem::create_directories(output.parent_path());

    MediaOutput pending(output);
    MfScope mf;
    ComPtr<IMFSourceReader> reader;
    ComPtr<IMFSinkWriter> writer;
    bool outputOpened = false;
    try {
        ComPtr<IMFAttributes> attributes;
        Check(MFCreateAttributes(&attributes, 2), "MFCreateAttributes");
        Check(attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, FALSE),
            "disable source reader video processing");
        Check(attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, TRUE),
            "disable source reader converters");
        const auto wideInput = ToWide(inputPath);
        Check(MFCreateSourceReaderFromURL(wideInput.c_str(), attributes.Get(), &reader),
            "MFCreateSourceReaderFromURL");
        Check(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE),
            "deselect source streams");

        // Audio tracks are copied in the order the file holds them. The reader
        // lists them in an order of its own (see audio_track_order.h), and
        // adding them to the writer in that order turned the tracks of every
        // trimmed clip back to front. A trim writes its order to disk for
        // good, so a clip whose tracks cannot be told apart is refused, before
        // any output exists.
        const AudioStreamOrder fileAudio = AudioStreamsInFileOrder(wideInput);
        if (fileAudio.streams.size() >= 2 && !fileAudio.matched)
            throw std::runtime_error("cannot tell this clip's audio tracks apart, so trimming it would mix them up");

        const auto wideOutput = pending.Partial().wstring();
        Check(MFCreateSinkWriterFromURL(wideOutput.c_str(), nullptr, nullptr, &writer),
            "MFCreateSinkWriterFromURL");
        outputOpened = true;

        std::vector<Stream> streams;
        size_t video = (std::numeric_limits<size_t>::max)();
        ComPtr<IMFMediaType> sourceVideoType;
        uint32_t width = 0, height = 0, fps = 0;
        size_t audioSeen = 0;
        for (DWORD slot = 0;; ++slot) {
            DWORD index = slot;
            ComPtr<IMFMediaType> type;
            const HRESULT result = reader->GetNativeMediaType(index, 0, &type);
            if (result == MF_E_INVALIDSTREAMNUMBER) break;
            Check(result, "IMFSourceReader::GetNativeMediaType");
            GUID major{};
            Check(type->GetGUID(MF_MT_MAJOR_TYPE, &major), "get native major type");
            if (major != MFMediaType_Video && major != MFMediaType_Audio) continue;
            if (major == MFMediaType_Audio && audioSeen < fileAudio.streams.size()) {
                index = fileAudio.streams[audioSeen++];
                type.Reset();
                Check(reader->GetNativeMediaType(index, 0, &type), "IMFSourceReader::GetNativeMediaType");
            }
            GUID subtype{};
            Check(type->GetGUID(MF_MT_SUBTYPE, &subtype), "get native subtype");
            if (major == MFMediaType_Video && subtype != MFVideoFormat_H264)
                throw std::runtime_error("input video is not H.264");
            if (major == MFMediaType_Audio && subtype != MFAudioFormat_AAC)
                throw std::runtime_error("input audio is not AAC");
            if (major == MFMediaType_Video) TagBt709Limited(type.Get());
            Check(reader->SetStreamSelection(index, TRUE), "select source stream");
            DWORD writerIndex = 0;
            Check(writer->AddStream(type.Get(), &writerIndex), "IMFSinkWriter::AddStream");
            Check(writer->SetInputMediaType(writerIndex, type.Get(), nullptr),
                "IMFSinkWriter::SetInputMediaType");
            streams.push_back({index, writerIndex, major});
            if (major == MFMediaType_Video) {
                if (video != (std::numeric_limits<size_t>::max)())
                    throw std::runtime_error("multiple video streams are not supported");
                video = streams.size() - 1;
                sourceVideoType = type;
                Check(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height),
                    "get video frame size");
                UINT32 numerator = 0, denominator = 0;
                if (SUCCEEDED(MFGetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, &numerator, &denominator)) && denominator)
                    fps = (numerator + denominator / 2) / denominator;
            }
        }
        if (video == (std::numeric_limits<size_t>::max)()) throw std::runtime_error("input clip has no H.264 video stream");

        // One pass over every video sample gives the keyframe list and, from the
        // same samples, the source's real bitrate. An MP4's native H.264 media
        // type carries no MF_MT_AVG_BITRATE, so without measuring it the head
        // encoder falls back to its own default.
        const VideoScan scan = ScanVideoStream(reader.Get(), streams[video].reader);
        const uint32_t sourceBitrate = VideoBitrate(scan);
        SeekReader(reader.Get(), 0);
        // Half a frame. Below anything a viewer can see, and wide enough that a
        // request landing a few microseconds off a keyframe still takes the
        // instant remux path instead of re-encoding the whole GOP.
        const int64_t snapToleranceUs = fps ? 500000 / fps : 0;
        const SmartRenderPlan renderPlan = PlanSmartRender(scan.keyframesUs, startUs, endUs, snapToleranceUs);
        Check(writer->BeginWriting(), "IMFSinkWriter::BeginWriting");

        bool renderedHead = false;
        if (renderPlan.needsHeadEncode) {
            ComPtr<IMFSourceReader> decodeReader;
            Check(MFCreateSourceReaderFromURL(wideInput.c_str(), nullptr, &decodeReader),
                "create head decoder");
            renderedHead = RenderHeadFragment(decodeReader.Get(), writer.Get(),
                streams[video].reader, streams[video].writer, renderPlan,
                sourceVideoType.Get(), sourceBitrate);
        }

        SeekReader(reader.Get(), startUs * 10);

        ReadNext(reader.Get(), streams[video]);
        if (!streams[video].sample) throw std::runtime_error("trim start is past the end of the input clip");
        // IMFSourceReader::SetCurrentPosition is documented as approximate: it
        // positions the source at or BEFORE the requested time, so asking for a
        // keyframe can return the keyframe before it. That sample is a clean
        // point too, so the check below waved it through, and the trim came back
        // a whole GOP early - measured at 1.02s on about half the keyframes this
        // app's own getClipKeyframes reports, the same ones every time, and
        // unaffected by nudging the request forward by up to 8ms.
        //
        // Read forward to the sample the plan actually meant. The tolerance is
        // the same half-frame the planner snapped with, so a request that landed
        // just before its keyframe stops there rather than running on.
        while (streams[video].sample &&
               streams[video].time / 10 + snapToleranceUs < startUs) {
            ReadNext(reader.Get(), streams[video]);
        }
        if (!streams[video].sample) throw std::runtime_error("trim start is past the end of the input clip");
        LONGLONG actualStart = streams[video].time;
        LONGLONG copyVideoStart = actualStart;
        if (renderedHead) {
            actualStart = renderPlan.headStartUs * 10;
            copyVideoStart = renderPlan.copyStartUs * 10;
        } else {
            UINT32 cleanPoint = FALSE;
            if (FAILED(streams[video].sample->GetUINT32(MFSampleExtension_CleanPoint, &cleanPoint)) || !cleanPoint)
                throw std::runtime_error("source reader did not seek to an H.264 keyframe");
        }
        const LONGLONG requestedEnd = endUs * 10;
        if (actualStart >= requestedEnd) throw std::runtime_error("trim range contains no decodable video");
        for (size_t i = 0; i < streams.size(); ++i) if (i != video) ReadNext(reader.Get(), streams[i]);

        LONGLONG outputEnd = renderedHead ? (renderPlan.headEndUs - renderPlan.headStartUs) * 10 : 0;
        bool wroteVideo = renderedHead;
        for (;;) {
            size_t next = streams.size();
            for (size_t i = 0; i < streams.size(); ++i) {
                if (!streams[i].sample || streams[i].time >= requestedEnd) continue;
                if (next == streams.size() || streams[i].time < streams[next].time) next = i;
            }
            if (next == streams.size()) break;
            auto& stream = streams[next];
            if (stream.time >= actualStart &&
                (stream.major != MFMediaType_Video || stream.time >= copyVideoStart)) {
                const LONGLONG rebased = RebaseTrimTimestamp(stream.time, actualStart);
                Check(stream.sample->SetSampleTime(rebased), "IMFSample::SetSampleTime");
                Check(writer->WriteSample(stream.writer, stream.sample.Get()), "IMFSinkWriter::WriteSample");
                LONGLONG duration = 0;
                if (FAILED(stream.sample->GetSampleDuration(&duration))) duration = 0;
                outputEnd = (std::max)(outputEnd, rebased + duration);
                wroteVideo = wroteVideo || stream.major == MFMediaType_Video;
            }
            ReadNext(reader.Get(), stream);
        }
        if (!wroteVideo) throw std::runtime_error("trim range contains no video samples");
        Check(writer->Finalize(), "IMFSinkWriter::Finalize");
        writer.Reset();

        pending.Publish();
        ClipMetadata metadata{outputPath, "", TrimTimestampSeconds(outputEnd), width, height, fps,
            std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::system_clock::now().time_since_epoch()).count()};
        metadata.actualStartSeconds = TrimTimestampSeconds(actualStart);
        return metadata;
    } catch (...) {
        writer.Reset();
        reader.Reset();
        if (outputOpened) {
            std::error_code ignored;
            std::filesystem::remove(pending.Partial(), ignored);
        }
        throw;
    }
#else
    (void)inputPath; (void)outputPath; (void)startUs; (void)endUs;
    throw std::runtime_error("clip trimming is only available on Windows");
#endif
}

} // namespace flash
