#include "clip_writer.h"
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
    const int64_t endUs = std::max(videoPackets.back().timestamp_us,
        audioPackets.empty() ? baseUs : audioPackets.back().timestamp_us);
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

    DWORD audioStream = 0;
    bool hasAudio = !audioPackets.empty();
    uint32_t sampleRate = hasAudio ? audioPackets.front().sampleRate : 48000;
    uint32_t channels = hasAudio ? audioPackets.front().channels : 2;
    if (hasAudio) {
        ComPtr<IMFMediaType> aacType, pcmType;
        Check(MFCreateMediaType(&aacType), "MFCreateMediaType(AAC)");
        aacType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        aacType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
        aacType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels);
        aacType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
        aacType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
        aacType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        aacType->SetUINT32(MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29);
        Check(writer->AddStream(aacType.Get(), &audioStream), "AddStream(AAC)");
        Check(MFCreateMediaType(&pcmType), "MFCreateMediaType(float PCM)");
        pcmType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        pcmType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
        pcmType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels);
        pcmType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
        pcmType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32);
        pcmType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * sizeof(float));
        pcmType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sampleRate * channels * sizeof(float));
        Check(writer->SetInputMediaType(audioStream, pcmType.Get(), nullptr), "SetInputMediaType(float PCM)");
    }
    Check(writer->BeginWriting(), "BeginWriting");

    size_t vi = 0, ai = 0;
    while (vi < videoPackets.size() || ai < audioPackets.size()) {
        const bool writeVideo = ai == audioPackets.size() ||
            (vi < videoPackets.size() && videoPackets[vi].timestamp_us <= audioPackets[ai].timestamp_us);
        if (writeVideo) {
            const auto& p = videoPackets[vi++];
            auto sample = MakeSample(p.data.data(), static_cast<DWORD>(p.data.size()),
                std::max<int64_t>(0, p.timestamp_us - baseUs) * 10, 10000000LL / fps);
            if (p.isKeyframe) sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
            Check(writer->WriteSample(videoStream, sample.Get()), "WriteSample(video)");
        } else {
            const auto& p = audioPackets[ai++];
            if (!p.samples || p.channels != channels || p.sampleRate != sampleRate) continue;
            const DWORD bytes = p.frameCount * p.channels * sizeof(float);
            auto sample = MakeSample(p.samples, bytes, std::max<int64_t>(0, p.timestamp_us - baseUs) * 10,
                static_cast<LONGLONG>(p.frameCount) * 10000000LL / p.sampleRate);
            Check(writer->WriteSample(audioStream, sample.Get()), "WriteSample(audio)");
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
