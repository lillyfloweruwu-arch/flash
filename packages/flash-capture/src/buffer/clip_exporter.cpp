#include "clip_exporter.h"
#include "export_budget.h"

#include <algorithm>
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
namespace {

constexpr uint32_t kMixRate = 48000;
constexpr uint32_t kMixChannels = 2;
// A share copy of an hour-long recording is not a thing anyone wants, and the
// mix timeline is held in memory, so refuse rather than exhaust RAM.
constexpr double kMaxExportSeconds = 15 * 60;

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

bool SamePath(const std::filesystem::path& left, const std::filesystem::path& right) {
    const auto a = std::filesystem::absolute(left).lexically_normal().wstring();
    const auto b = std::filesystem::absolute(right).lexically_normal().wstring();
    return CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(),
        static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}

ComPtr<IMFMediaType> MakeType(const GUID& major, const GUID& subtype) {
    ComPtr<IMFMediaType> type;
    Check(MFCreateMediaType(&type), "MFCreateMediaType");
    Check(type->SetGUID(MF_MT_MAJOR_TYPE, major), "set major type");
    Check(type->SetGUID(MF_MT_SUBTYPE, subtype), "set subtype");
    return type;
}

} // namespace
#endif

ExportResult ExportClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options) {
    if (inputPath.empty() || outputPath.empty()) throw std::invalid_argument("clip paths must not be empty");
    if (!options.maxBytes) throw std::invalid_argument("maxBytes must be greater than zero");
    if (options.startUs < 0 || (options.endUs && options.endUs <= options.startUs))
        throw std::invalid_argument("export range must have a non-negative start and end after start");

#ifdef _WIN32
    const auto input = std::filesystem::u8path(inputPath);
    const auto output = std::filesystem::u8path(outputPath);
    if (!std::filesystem::is_regular_file(input)) throw std::invalid_argument("input clip does not exist");
    if (SamePath(input, output)) throw std::invalid_argument("input and output clips must be different files");
    if (!output.parent_path().empty()) std::filesystem::create_directories(output.parent_path());

    MfScope mf;
    ComPtr<IMFSourceReader> reader;
    ComPtr<IMFSinkWriter> writer;
    bool outputOpened = false;
    try {
        // Decoding IS wanted here, unlike the trimmer: video processing gives us a
        // decoded, scaled NV12 stream, and the sink writer supplies the encoder.
        ComPtr<IMFAttributes> readerAttributes;
        Check(MFCreateAttributes(&readerAttributes, 1), "MFCreateAttributes(reader)");
        // ADVANCED only — it is the one that can resize, and setting it alongside
        // MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING is documented as invalid and
        // fails MFCreateSourceReaderFromURL outright with E_INVALIDARG.
        Check(readerAttributes->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE),
            "enable advanced video processing");
        const auto wideInput = ToWide(inputPath);
        Check(MFCreateSourceReaderFromURL(wideInput.c_str(), readerAttributes.Get(), &reader),
            "MFCreateSourceReaderFromURL");
        Check(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE), "deselect source streams");

        // Find the video stream and every audio stream. Flash writes game/mic/other
        // as separate tracks; all of them have to reach the mix.
        DWORD videoStream = static_cast<DWORD>(MF_SOURCE_READER_INVALID_STREAM_INDEX);
        std::vector<DWORD> audioStreams;
        uint32_t sourceWidth = 0, sourceHeight = 0, fps = 30;
        for (DWORD index = 0;; ++index) {
            ComPtr<IMFMediaType> type;
            const HRESULT result = reader->GetNativeMediaType(index, 0, &type);
            if (result == MF_E_INVALIDSTREAMNUMBER) break;
            Check(result, "IMFSourceReader::GetNativeMediaType");
            GUID major{};
            if (FAILED(type->GetGUID(MF_MT_MAJOR_TYPE, &major))) continue;
            if (major == MFMediaType_Video && videoStream == static_cast<DWORD>(MF_SOURCE_READER_INVALID_STREAM_INDEX)) {
                videoStream = index;
                MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &sourceWidth, &sourceHeight);
                UINT32 numerator = 0, denominator = 0;
                if (SUCCEEDED(MFGetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, &numerator, &denominator)) && denominator)
                    fps = (numerator + denominator / 2) / denominator;
            } else if (major == MFMediaType_Audio) {
                audioStreams.push_back(index);
            }
        }
        if (videoStream == static_cast<DWORD>(MF_SOURCE_READER_INVALID_STREAM_INDEX))
            throw std::runtime_error("input clip has no video stream");
        if (!sourceWidth || !sourceHeight) throw std::runtime_error("input clip has no frame size");

        PROPVARIANT durationValue;
        PropVariantInit(&durationValue);
        double sourceSeconds = 0.0;
        if (SUCCEEDED(reader->GetPresentationAttribute(static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE), MF_PD_DURATION, &durationValue)))
            sourceSeconds = static_cast<double>(durationValue.uhVal.QuadPart) / 10000000.0;
        PropVariantClear(&durationValue);
        if (sourceSeconds <= 0.0) throw std::runtime_error("could not read clip duration");

        const double startSeconds = static_cast<double>(options.startUs) / 1000000.0;
        const double endSeconds = options.endUs ? static_cast<double>(options.endUs) / 1000000.0 : sourceSeconds;
        const double span = (std::min)(endSeconds, sourceSeconds) - startSeconds;
        if (span <= 0.0) throw std::runtime_error("export range contains no video");
        if (span > kMaxExportSeconds) throw std::runtime_error("clip is too long to export");

        const ExportPlan plan = PlanExport(sourceWidth, sourceHeight, fps, span, options.maxBytes, options.maxHeight);
        if (!plan.width || !plan.height) throw std::runtime_error("could not plan an export size");

        // Ask the reader for decoded NV12 already scaled to the target size.
        auto videoInput = MakeType(MFMediaType_Video, MFVideoFormat_NV12);
        Check(MFSetAttributeSize(videoInput.Get(), MF_MT_FRAME_SIZE, plan.width, plan.height), "set export frame size");
        Check(reader->SetStreamSelection(videoStream, TRUE), "select video stream");
        Check(reader->SetCurrentMediaType(videoStream, nullptr, videoInput.Get()), "set decoded video type");
        ComPtr<IMFMediaType> actualVideo;
        Check(reader->GetCurrentMediaType(videoStream, &actualVideo), "get decoded video type");
        uint32_t outWidth = plan.width, outHeight = plan.height;
        MFGetAttributeSize(actualVideo.Get(), MF_MT_FRAME_SIZE, &outWidth, &outHeight);

        auto audioInput = MakeType(MFMediaType_Audio, MFAudioFormat_Float);
        Check(audioInput->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, kMixChannels), "mix channels");
        Check(audioInput->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, kMixRate), "mix rate");
        Check(audioInput->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32), "mix bits");
        Check(audioInput->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, kMixChannels * sizeof(float)), "mix block align");
        Check(audioInput->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kMixRate * kMixChannels * sizeof(float)), "mix bytes/sec");
        for (DWORD stream : audioStreams) {
            if (FAILED(reader->SetStreamSelection(stream, TRUE))) continue;
            if (FAILED(reader->SetCurrentMediaType(stream, nullptr, audioInput.Get())))
                reader->SetStreamSelection(stream, FALSE);   // cannot decode it; leave it out
        }

        // Sum every audio track into one timeline. Discord, Chromium and every
        // upload path play only the FIRST audio track, so a multi-track share copy
        // sounds like the mic is missing — the mixdown is the whole point.
        const int64_t startTicks = static_cast<int64_t>(startSeconds * 10000000.0);
        const int64_t endTicks = static_cast<int64_t>((startSeconds + span) * 10000000.0);
        const size_t mixFrames = static_cast<size_t>(span * kMixRate) + kMixRate;
        std::vector<float> mix(mixFrames * kMixChannels, 0.0f);
        bool haveAudio = false;
        for (DWORD stream : audioStreams) {
            PROPVARIANT seek;
            PropVariantInit(&seek);
            seek.vt = VT_I8;
            seek.hVal.QuadPart = startTicks;
            reader->SetCurrentPosition(GUID_NULL, seek);
            PropVariantClear(&seek);
            for (;;) {
                DWORD actual = 0, flags = 0;
                LONGLONG time = 0;
                ComPtr<IMFSample> sample;
                if (FAILED(reader->ReadSample(stream, 0, &actual, &flags, &time, &sample))) break;
                if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
                if (!sample) continue;
                if (time >= endTicks) break;
                ComPtr<IMFMediaBuffer> buffer;
                if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) continue;
                BYTE* data = nullptr;
                DWORD length = 0;
                if (FAILED(buffer->Lock(&data, nullptr, &length))) continue;
                const size_t frames = length / (kMixChannels * sizeof(float));
                const int64_t offsetTicks = time - startTicks;
                size_t at = offsetTicks > 0
                    ? static_cast<size_t>((offsetTicks / 10000000.0) * kMixRate) : 0;
                const float* source = reinterpret_cast<const float*>(data);
                for (size_t f = 0; f < frames && at + f < mixFrames; ++f)
                    for (uint32_t c = 0; c < kMixChannels; ++c)
                        mix[(at + f) * kMixChannels + c] += source[f * kMixChannels + c];
                buffer->Unlock();
                haveAudio = true;
            }
        }
        for (float& sample : mix) sample = (std::max)(-1.0f, (std::min)(1.0f, sample));

        std::error_code ignored;
        std::filesystem::remove(output, ignored);
        ComPtr<IMFAttributes> writerAttributes;
        Check(MFCreateAttributes(&writerAttributes, 1), "MFCreateAttributes(writer)");
        Check(writerAttributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE),
            "enable hardware transforms");
        const auto wideOutput = ToWide(outputPath);
        Check(MFCreateSinkWriterFromURL(wideOutput.c_str(), nullptr, writerAttributes.Get(), &writer),
            "MFCreateSinkWriterFromURL");
        outputOpened = true;

        // Giving the writer an encoded target type and an uncompressed input type
        // makes it instantiate the encoder itself — no manual MFT wiring.
        auto videoTarget = MakeType(MFMediaType_Video, MFVideoFormat_H264);
        Check(MFSetAttributeSize(videoTarget.Get(), MF_MT_FRAME_SIZE, outWidth, outHeight), "target frame size");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_FRAME_RATE, plan.fps, 1), "target frame rate");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "target aspect");
        Check(videoTarget->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "target interlace");
        Check(videoTarget->SetUINT32(MF_MT_AVG_BITRATE, plan.videoKbps * 1000), "target bitrate");
        DWORD videoOut = 0;
        Check(writer->AddStream(videoTarget.Get(), &videoOut), "AddStream(video)");
        Check(writer->SetInputMediaType(videoOut, actualVideo.Get(), nullptr), "SetInputMediaType(video)");

        DWORD audioOut = 0;
        if (haveAudio) {
            auto audioTarget = MakeType(MFMediaType_Audio, MFAudioFormat_AAC);
            Check(audioTarget->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, kMixChannels), "aac channels");
            Check(audioTarget->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, kMixRate), "aac rate");
            Check(audioTarget->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16), "aac bits");
            Check(audioTarget->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kExportAudioKbps * 1000 / 8), "aac bytes/sec");
            Check(writer->AddStream(audioTarget.Get(), &audioOut), "AddStream(audio)");
            Check(writer->SetInputMediaType(audioOut, audioInput.Get(), nullptr), "SetInputMediaType(audio)");
        }
        Check(writer->BeginWriting(), "IMFSinkWriter::BeginWriting");

        // Interleave: the sink writer needs samples in roughly increasing time
        // order across streams, so audio is emitted in chunks as video advances.
        const size_t chunkFrames = kMixRate / 10;   // 100ms
        size_t audioCursor = 0;
        auto writeAudioUpTo = [&](LONGLONG untilTicks) {
            if (!haveAudio) return;
            while (audioCursor < mixFrames) {
                const LONGLONG at = static_cast<LONGLONG>((static_cast<double>(audioCursor) / kMixRate) * 10000000.0);
                if (at > untilTicks) break;
                const size_t frames = (std::min)(chunkFrames, mixFrames - audioCursor);
                const DWORD bytes = static_cast<DWORD>(frames * kMixChannels * sizeof(float));
                ComPtr<IMFMediaBuffer> buffer;
                Check(MFCreateMemoryBuffer(bytes, &buffer), "MFCreateMemoryBuffer(audio)");
                BYTE* target = nullptr;
                Check(buffer->Lock(&target, nullptr, nullptr), "lock audio buffer");
                memcpy(target, mix.data() + audioCursor * kMixChannels, bytes);
                buffer->Unlock();
                Check(buffer->SetCurrentLength(bytes), "set audio length");
                ComPtr<IMFSample> sample;
                Check(MFCreateSample(&sample), "MFCreateSample(audio)");
                Check(sample->AddBuffer(buffer.Get()), "add audio buffer");
                Check(sample->SetSampleTime(at), "set audio time");
                Check(sample->SetSampleDuration(
                    static_cast<LONGLONG>((static_cast<double>(frames) / kMixRate) * 10000000.0)), "set audio duration");
                Check(writer->WriteSample(audioOut, sample.Get()), "WriteSample(audio)");
                audioCursor += frames;
            }
        };

        PROPVARIANT seekVideo;
        PropVariantInit(&seekVideo);
        seekVideo.vt = VT_I8;
        seekVideo.hVal.QuadPart = startTicks;
        Check(reader->SetCurrentPosition(GUID_NULL, seekVideo), "seek video");
        PropVariantClear(&seekVideo);

        LONGLONG lastEnd = 0, lastSlot = -1;
        bool wroteVideo = false;
        for (;;) {
            DWORD actual = 0, flags = 0;
            LONGLONG time = 0;
            ComPtr<IMFSample> sample;
            Check(reader->ReadSample(videoStream, 0, &actual, &flags, &time, &sample), "ReadSample(video)");
            if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
            if (!sample) continue;
            if (time >= endTicks) break;
            const LONGLONG rebased = (std::max)(0LL, time - startTicks);
            if (plan.fps < fps) {   // halved rate: keep every other frame
                const LONGLONG slot = rebased / (10000000LL / (std::max)(1u, plan.fps));
                if (slot == lastSlot) continue;
                lastSlot = slot;
            }
            Check(sample->SetSampleTime(rebased), "set video time");
            Check(writer->WriteSample(videoOut, sample.Get()), "WriteSample(video)");
            LONGLONG duration = 0;
            if (FAILED(sample->GetSampleDuration(&duration))) duration = 0;
            lastEnd = (std::max)(lastEnd, rebased + duration);
            wroteVideo = true;
            writeAudioUpTo(rebased);
        }
        if (!wroteVideo) throw std::runtime_error("export range contains no video samples");
        // Stop at the video end: the mix buffer carries a second of slack so a late
        // audio packet is never clipped, and writing all of it would leave the
        // export a second longer than the picture.
        writeAudioUpTo(lastEnd);

        Check(writer->Finalize(), "IMFSinkWriter::Finalize");
        writer.Reset();
        reader.Reset();

        ExportResult result;
        result.filePath = outputPath;
        result.durationSeconds = static_cast<double>(lastEnd) / 10000000.0;
        result.width = outWidth;
        result.height = outHeight;
        result.bytes = std::filesystem::file_size(output, ignored);
        result.bitrateKbps = result.durationSeconds > 0.0
            ? static_cast<uint32_t>((result.bytes * 8.0) / result.durationSeconds / 1000.0) : 0;
        return result;
    } catch (...) {
        writer.Reset();
        reader.Reset();
        if (outputOpened) {
            std::error_code ignored;
            std::filesystem::remove(output, ignored);
        }
        throw;
    }
#else
    (void)inputPath; (void)outputPath; (void)options;
    throw std::runtime_error("clip export is only available on Windows");
#endif
}

} // namespace flash
