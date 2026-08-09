#include "clip_writer.h"
#include "audio_tracks.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <stdexcept>

#ifdef _WIN32
#include <Windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

ClipWriter::ClipWriter() = default;
ClipWriter::~ClipWriter() = default;

#ifdef _WIN32
static std::wstring ToWide(const std::string& value) {
    if (value.empty()) return {};
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (!count) throw std::runtime_error("clip path is not valid UTF-8");
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), count);
    return result;
}

static void Check(HRESULT hr, const char* operation) {
    if (FAILED(hr)) throw std::runtime_error(std::string(operation) + " failed (HRESULT " + std::to_string(static_cast<unsigned long>(hr)) + ")");
}

static ComPtr<IMFSample> MakeSample(const void* bytes, DWORD length, LONGLONG time, LONGLONG duration) {
    ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateMemoryBuffer(length, &buffer), "MFCreateMemoryBuffer");
    BYTE* target = nullptr;
    Check(buffer->Lock(&target, nullptr, nullptr), "IMFMediaBuffer::Lock");
    if (length) std::memcpy(target, bytes, length);
    buffer->Unlock();
    Check(buffer->SetCurrentLength(length), "IMFMediaBuffer::SetCurrentLength");
    ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "MFCreateSample");
    Check(sample->AddBuffer(buffer.Get()), "IMFSample::AddBuffer");
    Check(sample->SetSampleTime(time), "IMFSample::SetSampleTime");
    Check(sample->SetSampleDuration(duration), "IMFSample::SetSampleDuration");
    return sample;
}
#endif

ClipMetadata ClipWriter::Write(const std::string& outputPath,
    const std::vector<EncodedPacket>& videoPackets, const std::vector<AudioData>& audioPackets,
    uint32_t width, uint32_t height, uint32_t fps, const std::string& gameName) {
    if (videoPackets.empty()) throw std::invalid_argument("cannot write a clip without video packets");
    if (!width || !height || !fps) throw std::invalid_argument("invalid video dimensions or frame rate");
    std::filesystem::path path = std::filesystem::u8path(outputPath);
    if (!path.parent_path().empty()) std::filesystem::create_directories(path.parent_path());

    ClipMetadata meta{outputPath, gameName, 0, width, height, fps, 0};
    meta.timestamp = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    const int64_t baseUs = videoPackets.front().timestamp_us;
    int64_t endUs = videoPackets.back().timestamp_us;
    for (const auto& packet : audioPackets) endUs = (std::max)(endUs, packet.timestamp_us);
    meta.durationSeconds = static_cast<uint32_t>(std::max<int64_t>(0, endUs - baseUs + 999999) / 1000000);

#ifdef _WIN32
    Check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "MFStartup");
    struct Shutdown { ~Shutdown() { MFShutdown(); } } shutdown;
    ComPtr<IMFSinkWriter> writer;
    std::wstring widePath = ToWide(outputPath);
    Check(MFCreateSinkWriterFromURL(widePath.c_str(), nullptr, nullptr, &writer), "MFCreateSinkWriterFromURL");

    DWORD videoStream = 0;
    ComPtr<IMFMediaType> videoType;
    Check(MFCreateMediaType(&videoType), "MFCreateMediaType(video)");
    Check(videoType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "video major type");
    Check(videoType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264), "video subtype");
    Check(MFSetAttributeSize(videoType.Get(), MF_MT_FRAME_SIZE, width, height), "video frame size");
    Check(MFSetAttributeRatio(videoType.Get(), MF_MT_FRAME_RATE, fps, 1), "video frame rate");
    Check(MFSetAttributeRatio(videoType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "video pixel aspect");
    Check(videoType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "video interlace mode");
    Check(writer->AddStream(videoType.Get(), &videoStream), "AddStream(video)");
    Check(writer->SetInputMediaType(videoStream, videoType.Get(), nullptr), "SetInputMediaType(video)");

    struct AudioStream { std::string_view id; DWORD index = 0; uint32_t sampleRate = 0, channels = 0; bool present = false; };
    std::array<AudioStream, 3> audioStreams{};
    for (size_t i = 0; i < kAudioTrackOrder.size(); ++i) {
        audioStreams[i].id = kAudioTrackOrder[i];
        auto first = std::find_if(audioPackets.begin(), audioPackets.end(), [&](const AudioData& p) { return p.sourceId == kAudioTrackOrder[i]; });
        if (first == audioPackets.end()) continue;
        auto& stream = audioStreams[i]; stream.present = true; stream.sampleRate = first->sampleRate; stream.channels = first->channels;
        ComPtr<IMFMediaType> aacType, pcmType;
        Check(MFCreateMediaType(&aacType), "MFCreateMediaType(AAC)");
        aacType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        aacType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
        aacType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, stream.channels);
        aacType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, stream.sampleRate);
        aacType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
        aacType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        aacType->SetUINT32(MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29);
        Check(writer->AddStream(aacType.Get(), &stream.index), "AddStream(AAC)");
        Check(MFCreateMediaType(&pcmType), "MFCreateMediaType(float PCM)");
        pcmType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        pcmType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
        pcmType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, stream.channels);
        pcmType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, stream.sampleRate);
        pcmType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32);
        pcmType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, stream.channels * sizeof(float));
        pcmType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, stream.sampleRate * stream.channels * sizeof(float));
        Check(writer->SetInputMediaType(stream.index, pcmType.Get(), nullptr), "SetInputMediaType(float PCM)");
    }
    Check(writer->BeginWriting(), "BeginWriting");

    // IMFSinkWriter needs samples delivered in roughly increasing timestamp order
    // ACROSS streams. Writing one stream to completion and then rewinding to t=0
    // for the next makes it buffer the entire clip and stall, so collect every
    // sample into one time-ordered schedule and write that.
    struct Write { int64_t timeUs; DWORD stream; const EncodedPacket* video; const AudioData* audio; };
    std::vector<Write> schedule;
    schedule.reserve(videoPackets.size() + audioPackets.size());
    for (const auto& p : videoPackets) schedule.push_back({p.timestamp_us, videoStream, &p, nullptr});
    for (const auto& stream : audioStreams) if (stream.present) {
        for (const auto& p : audioPackets) {
            if (p.sourceId != stream.id || !p.samples || p.channels != stream.channels || p.sampleRate != stream.sampleRate) continue;
            schedule.push_back({p.timestamp_us, stream.index, nullptr, &p});
        }
    }
    // Stable so that samples sharing a timestamp keep video-before-audio order.
    std::stable_sort(schedule.begin(), schedule.end(),
        [](const Write& a, const Write& b) { return a.timeUs < b.timeUs; });

    for (const auto& w : schedule) {
        const LONGLONG time = std::max<int64_t>(0, w.timeUs - baseUs) * 10;
        if (w.video) {
            auto sample = MakeSample(w.video->data.data(), static_cast<DWORD>(w.video->data.size()),
                time, 10000000LL / fps);
            if (w.video->isKeyframe) sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
            Check(writer->WriteSample(w.stream, sample.Get()), "WriteSample(video)");
        } else {
            const DWORD bytes = w.audio->frameCount * w.audio->channels * sizeof(float);
            auto sample = MakeSample(w.audio->samples, bytes, time,
                static_cast<LONGLONG>(w.audio->frameCount) * 10000000LL / w.audio->sampleRate);
            Check(writer->WriteSample(w.stream, sample.Get()), "WriteSample(audio)");
        }
    }
    Check(writer->Finalize(), "IMFSinkWriter::Finalize");
    return meta;
#else
    (void)audioPackets;
    throw std::runtime_error("MP4 writing is only available on Windows");
#endif
}

std::string ClipWriter::GenerateClipPath(const std::string& baseDir, const std::string& gameName) {
    auto now = std::chrono::system_clock::now();
    auto time = std::chrono::system_clock::to_time_t(now);
    struct tm local{};
#ifdef _WIN32
    localtime_s(&local, &time);
#else
    localtime_r(&time, &local);
#endif
    char stamp[32];
    std::strftime(stamp, sizeof(stamp), "%Y-%m-%d_%H-%M-%S.mp4", &local);
    std::string safe = gameName.empty() ? "Unknown" : gameName;
    for (char& c : safe) if (c == '<' || c == '>' || c == ':' || c == '"' || c == '/' || c == '\\' || c == '|' || c == '?' || c == '*') c = '_';
    return (std::filesystem::u8path(baseDir) / std::filesystem::u8path(safe) / stamp).string();
}

} // namespace flash
