#include "../../core/clip_exporter.h"
#include "../../core/export_budget.h"
#include "media_output.h"
#include "audio_track_order.h"
#include "color_space.h"

#include <algorithm>
#include <cstdlib>
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
#include <mftransform.h>
#include <codecapi.h>
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
    if (major == MFMediaType_Video) TagBt709Limited(type.Get());
    return type;
}

// Thrown when the chosen codec cannot be set up, so the caller can step down
// the ladder. ExportClip also raises it when a newer codec fails once writing
// has begun and no copy has been kept.
struct CodecUnavailable final : std::runtime_error {
    using std::runtime_error::runtime_error;
};

const GUID& Subtype(ExportCodec codec) {
    switch (codec) {
        case ExportCodec::Av1: return MFVideoFormat_AV1;
        case ExportCodec::Hevc: return MFVideoFormat_HEVC;
        default: return MFVideoFormat_H264;
    }
}

// AV1 and HEVC are only worth using through the GPU: Windows ships no software
// encoder for either.
bool HasHardwareEncoder(const GUID& subtype) {
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, subtype};
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    const HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr, &output, &activates, &count);
    if (FAILED(hr)) return false;
    for (UINT32 i = 0; i < count; ++i) activates[i]->Release();
    CoTaskMemFree(activates);
    return count > 0;
}

std::vector<ExportCodec> CodecLadder(ExportCodecChoice choice) {
    if (choice == ExportCodecChoice::H264) return {ExportCodec::H264};
    // A test hook: start the ladder at a given step, so the HEVC and H.264
    // paths can be exercised on a machine whose GPU has AV1.
    ExportCodec forced = ExportCodec::Av1;
    char* value = nullptr;
    size_t valueSize = 0;
    _dupenv_s(&value, &valueSize, "FLASH_EXPORT_CODEC");
    const bool haveForced = ParseExportCodec(value, forced);
    std::free(value);
    std::vector<ExportCodec> ladder;
    MfScope mf;
    if ((!haveForced || forced == ExportCodec::Av1) && HasHardwareEncoder(MFVideoFormat_AV1))
        ladder.push_back(ExportCodec::Av1);
    if ((!haveForced || forced != ExportCodec::H264) && HasHardwareEncoder(MFVideoFormat_HEVC))
        ladder.push_back(ExportCodec::Hevc);
    ladder.push_back(ExportCodec::H264);
    return ladder;
}

// Encoder settings the sink writer hands to whichever encoder it creates. All
// of them are requests: an encoder that cannot honour one ignores it, and the
// caller falls back to no settings at all if the set is refused outright.
ComPtr<IMFAttributes> EncoderSettings(const ExportPlan& plan) {
    ComPtr<IMFAttributes> settings;
    Check(MFCreateAttributes(&settings, 7), "MFCreateAttributes(encoder)");
    settings->SetUINT32(CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_PeakConstrainedVBR);
    settings->SetUINT32(CODECAPI_AVEncCommonMeanBitRate, plan.videoKbps * 1000);
    settings->SetUINT32(CODECAPI_AVEncCommonMaxBitRate, plan.videoKbps * 1500);
    settings->SetUINT32(CODECAPI_AVEncMPVDefaultBPictureCount, 2);
    // Four seconds between keyframes: a share copy is watched start to finish,
    // and every keyframe spent on seekability is bits taken from the picture.
    settings->SetUINT32(CODECAPI_AVEncMPVGOPSize, plan.fps * 4);
    settings->SetUINT32(CODECAPI_AVEncCommonQualityVsSpeed, 100);
    if (plan.codec == ExportCodec::H264) settings->SetUINT32(CODECAPI_AVEncH264CABACEnable, TRUE);
    return settings;
}

} // namespace
#endif

static ExportResult EncodeClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options, ExportPlan& usedPlan, bool retry, ExportCodec codec) {
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
        // Gains are per track, a track is named by its place in the file, and
        // the reader lists streams in an order of its own. A clip that cannot
        // be matched is still exported, in the reader's order, and that is logged.
        if (auto ordered = AudioStreamsInFileOrder(wideInput); ordered.streams.size() == audioStreams.size()) {
            if (!ordered.matched) LogUnmatchedTrackOrder(wideInput, "export");
            audioStreams = std::move(ordered.streams);
        }
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

        // The source's overall bitrate caps a size-limited copy: more bits than
        // the original had cannot make it look better.
        const bool limited = options.maxBytes < kExportUnlimitedBytes;
        const uint32_t sourceKbps = limited
            ? static_cast<uint32_t>((std::min)(static_cast<double>(kExportMaxVideoKbps),
                std::filesystem::file_size(input) * 8.0 / 1000.0 / sourceSeconds))
            : 0;
        const ExportPlan plan = retry ? usedPlan : PlanExport(sourceWidth, sourceHeight, fps, span,
            options.maxBytes, options.maxHeight, codec, options.maxFps, sourceKbps);
        if (!plan.width || !plan.height) throw std::runtime_error("export size budget is too small for the minimum video and audio bitrate");
        usedPlan = plan;

        // Ask the reader for decoded NV12 already scaled to the target size.
        auto videoInput = MakeType(MFMediaType_Video, MFVideoFormat_NV12);
        Check(MFSetAttributeSize(videoInput.Get(), MF_MT_FRAME_SIZE, plan.width, plan.height), "set export frame size");
        Check(reader->SetStreamSelection(videoStream, TRUE), "select video stream");
        Check(reader->SetCurrentMediaType(videoStream, nullptr, videoInput.Get()), "set decoded video type");
        ComPtr<IMFMediaType> actualVideo;
        Check(reader->GetCurrentMediaType(videoStream, &actualVideo), "get decoded video type");
        TagBt709Limited(actualVideo.Get());   // the reader hands back an untagged type
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
        // audioStreams was put in file order above (the reader's own order is
        // not that), and clip_writer writes every track of kAudioTrackOrder in
        // that order, so position here is position in options.gains.
        // A gain of exactly zero is skipped rather than multiplied, so a muted
        // track contributes nothing at all instead of a very quiet copy.
        for (size_t track = 0; track < audioStreams.size(); ++track) {
            const DWORD stream = audioStreams[track];
            const float gain = track < options.gains.size() ? options.gains[track] : 1.0f;
            if (gain == 0.0f) continue;
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
                const size_t at = offsetTicks > 0
                    ? static_cast<size_t>((offsetTicks / 10000000.0) * kMixRate) : 0;
                // A packet that straddles the in-point used to be mixed in whole
                // at offset zero, so an export starting mid-packet opened with up
                // to a packet of audio from before the cut - audible pre-roll
                // under a picture that starts in the right place.
                const size_t skip = offsetTicks < 0
                    ? (std::min)(frames, static_cast<size_t>(
                        ((startTicks - time) * kMixRate + 9999999) / 10000000)) : 0;
                const float* source = reinterpret_cast<const float*>(data);
                for (size_t f = skip; f < frames && at + f - skip < mixFrames; ++f)
                    for (uint32_t c = 0; c < kMixChannels; ++c)
                        mix[(at + f - skip) * kMixChannels + c] += source[f * kMixChannels + c] * gain;
                buffer->Unlock();
                haveAudio = haveAudio || (skip < frames && at < mixFrames);
            }
        }
        for (float& sample : mix) sample = (std::max)(-1.0f, (std::min)(1.0f, sample));

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
        auto videoTarget = MakeType(MFMediaType_Video, Subtype(plan.codec));
        Check(MFSetAttributeSize(videoTarget.Get(), MF_MT_FRAME_SIZE, outWidth, outHeight), "target frame size");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_FRAME_RATE, plan.fps, 1), "target frame rate");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "target aspect");
        Check(videoTarget->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "target interlace");
        Check(videoTarget->SetUINT32(MF_MT_AVG_BITRATE, plan.videoKbps * 1000), "target bitrate");
        // Without a profile the hardware encoder defaults to Constrained
        // Baseline, which is what made share copies look the way they did.
        if (plan.codec == ExportCodec::H264)
            Check(videoTarget->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High), "target profile");
        // A codec the writer or encoder will not set up is a reason to step
        // down the ladder, not to fail the export. H.264 is the last step, so
        // there it is a real error.
        const auto setup = [&](HRESULT hr, const char* operation) {
            if (SUCCEEDED(hr)) return;
            if (plan.codec != ExportCodec::H264) throw CodecUnavailable(operation);
            Check(hr, operation);
        };
        DWORD videoOut = 0;
        setup(writer->AddStream(videoTarget.Get(), &videoOut), "AddStream(video)");
        // Only size-limited exports get tuned encoder settings; the editor's
        // full-quality save keeps the encoder defaults.
        if (!limited || FAILED(writer->SetInputMediaType(videoOut, actualVideo.Get(), EncoderSettings(plan).Get())))
            setup(writer->SetInputMediaType(videoOut, actualVideo.Get(), nullptr), "SetInputMediaType(video)");

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
        setup(writer->BeginWriting(), "IMFSinkWriter::BeginWriting");

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

        LONGLONG lastEnd = 0;
        // Below the source rate, frames are re-timed onto an even grid. At the
        // source rate they keep their own timestamps untouched.
        const bool regrid = plan.fps < fps;
        FrameGrid grid{plan.fps};
        const LONGLONG frameTicks = 10000000LL / (std::max)(1u, plan.fps);
        bool wroteVideo = false;
        for (;;) {
            DWORD actual = 0, flags = 0;
            LONGLONG time = 0;
            ComPtr<IMFSample> sample;
            Check(reader->ReadSample(videoStream, 0, &actual, &flags, &time, &sample), "ReadSample(video)");
            if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
            if (!sample) continue;
            if (time >= endTicks) break;
            // Frames before the in-point were clamped to zero rather than
            // dropped, so every frame between the keyframe the reader had to
            // start from and the requested start piled up on timestamp zero.
            if (time < startTicks) continue;
            LONGLONG rebased = time - startTicks;
            if (regrid) {
                const int64_t slot = grid.Take(rebased / 10);
                if (slot < 0) continue;
                rebased = slot * 10000000LL / plan.fps;
                Check(sample->SetSampleDuration(frameTicks), "set video duration");
            }
            Check(sample->SetSampleTime(rebased), "set video time");
            // Saturation is a scale of each chroma sample about neutral, applied
            // in place on the NV12 UV plane. Luma is untouched. At 100 the pass
            // is skipped entirely so an unmodified export stays on the fast path.
            if (options.saturation != 100) {
                ComPtr<IMFMediaBuffer> frame;
                if (SUCCEEDED(sample->ConvertToContiguousBuffer(&frame))) {
                    BYTE* pixels = nullptr;
                    DWORD length = 0;
                    if (SUCCEEDED(frame->Lock(&pixels, nullptr, &length))) {
                        const size_t luma = static_cast<size_t>(outWidth) * outHeight;
                        if (length >= luma + luma / 2)
                            for (size_t i = luma; i < luma + luma / 2; ++i)
                                pixels[i] = ApplySaturation(pixels[i], options.saturation);
                        frame->Unlock();
                    }
                }
            }
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
        result.bytes = std::filesystem::file_size(output);
        result.bitrateKbps = result.durationSeconds > 0.0
            ? static_cast<uint32_t>((result.bytes * 8.0) / result.durationSeconds / 1000.0) : 0;
        result.codec = ExportCodecName(plan.codec);
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
    (void)inputPath; (void)outputPath; (void)options; (void)usedPlan; (void)retry; (void)codec;
    throw std::runtime_error("clip export is only available on Windows");
#endif
}

ExportResult ExportClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options) {
#ifdef _WIN32
    if (inputPath.empty() || outputPath.empty()) throw std::invalid_argument("clip paths must not be empty");
    MediaOutput output(std::filesystem::u8path(outputPath));
    // Each attempt is encoded beside the reserved partial file and only moved
    // onto it when it fits and is the largest so far. That way a retry that
    // overshoots cannot cost the copy that already fit.
    std::filesystem::path attempt = output.Partial();
    attempt += L".try.mp4";
    struct Remove {
        std::filesystem::path path;
        ~Remove() { std::error_code ignored; std::filesystem::remove(path, ignored); }
    } cleanup{attempt};
    const auto utf8 = attempt.u8string();
    const std::string attemptPath(utf8.begin(), utf8.end());

    const std::vector<ExportCodec> ladder = CodecLadder(options.codec);
    for (ExportCodec codec : ladder) {
        try {
            ExportPlan plan;
            ExportResult best;
            bool kept = false;
            for (int round = 0; round < 3; ++round) {
                ExportResult result;
                try {
                    result = EncodeClip(inputPath, attemptPath, options, plan, round != 0, codec);
                } catch (const std::exception& error) {
                    // A copy that already fits outranks a failed retry.
                    if (kept) break;
                    // A hardware encoder can accept set-up and then fail on the
                    // first sample or at finalize. With nothing kept and an
                    // older codec left, that is a reason to step down, not to
                    // fail. The last codec's error is the real one, and no
                    // codec can fix a bad argument.
                    if (codec == ladder.back() || dynamic_cast<const std::invalid_argument*>(&error)) throw;
                    throw CodecUnavailable(error.what());
                }
                if (result.bytes <= options.maxBytes && (!kept || result.bytes > best.bytes)) {
                    std::filesystem::rename(attempt, output.Partial());
                    best = result;
                    kept = true;
                }
                if (!ExportNeedsRetry(plan, options.maxBytes, result.bytes)) break;
                plan = RetryExportPlan(plan, options.maxBytes, result.bytes);
                if (!plan.width) break;
            }
            if (!kept) throw std::runtime_error("export still exceeds the requested size budget after retry");
            output.Publish();
            best.filePath = outputPath;
            return best;
        } catch (const CodecUnavailable&) {
            continue;   // next step of the ladder
        }
    }
    throw std::runtime_error("no video encoder accepted the export");
#else
    (void)inputPath; (void)outputPath; (void)options;
    throw std::runtime_error("clip export is only available on Windows");
#endif
}

} // namespace flash
