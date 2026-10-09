#include "../../core/clip_writer.h"
#include "../../core/audio_tracks.h"
#include "color_space.h"
#include "media_output.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <mutex>
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
    const int64_t baseUs = videoPackets.front().pts_us;
    int64_t endUs = videoPackets.back().pts_us;
    for (const auto& packet : audioPackets) endUs = (std::max)(endUs, packet.timestamp_us);
    meta.durationSeconds = static_cast<uint32_t>(std::max<int64_t>(0, endUs - baseUs + 999999) / 1000000);

#ifdef _WIN32
    Check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "MFStartup");
    struct Shutdown { ~Shutdown() { MFShutdown(); } } shutdown;
    MediaOutput output(path);
    ComPtr<IMFSinkWriter> writer;
    std::wstring widePath = output.Partial().wstring();
    try {
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
    TagBt709Limited(videoType.Get());   // so the MP4 carries a colour box
    Check(writer->AddStream(videoType.Get(), &videoStream), "AddStream(video)");
    Check(writer->SetInputMediaType(videoStream, videoType.Get(), nullptr), "SetInputMediaType(video)");

    struct AudioStream { std::string_view id; DWORD index = 0; uint32_t sampleRate = 0, channels = 0; bool present = false; };
    std::array<AudioStream, 3> audioStreams{};
    // Every clip carries all three tracks from kAudioTrackOrder, even a silent
    // one. The editor maps tracks to mixer lanes by position, so dropping an
    // empty stream would put Discord's audio on the mic lane. A track with no
    // packets still gets its stream and is then never written to — a few hundred
    // bytes of header and no sample data. A clip with no audio at all still gets
    // no audio streams, since there is nothing to keep aligned.
    uint32_t fallbackRate = 0, fallbackChannels = 0;
    for (const auto& p : audioPackets)
        if (p.samples && p.sampleRate && p.channels) { fallbackRate = p.sampleRate; fallbackChannels = p.channels; break; }
    for (size_t i = 0; fallbackRate && i < kAudioTrackOrder.size(); ++i) {
        audioStreams[i].id = kAudioTrackOrder[i];
        auto first = std::find_if(audioPackets.begin(), audioPackets.end(), [&](const AudioData& p) { return p.sourceId == kAudioTrackOrder[i]; });
        auto& stream = audioStreams[i];
        stream.present = first != audioPackets.end();
        stream.sampleRate = stream.present ? first->sampleRate : fallbackRate;
        stream.channels = stream.present ? first->channels : fallbackChannels;
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
    // Two separate failures, one cause: a stream whose timeline does not reach
    // the end of the clip.
    //
    // A stream that never receives a sample at all is dropped from the file by
    // IMFSinkWriter::Finalize, which renumbers the remaining tracks and puts
    // Discord's audio on the mic lane in the editor.
    //
    // A stream that receives samples and then STOPS is worse: Finalize is not
    // reached at all. IMFSinkWriter waits for that stream's timeline to catch up
    // with video that runs on to the end, and saveClip never returns. That is
    // what happens when the microphone is switched off mid-session, which is a
    // thing the Settings toggle now actually does.
    //
    // Both are fixed the same way: wherever a track has no packet and the
    // reference track does, write silence with the reference's timing.
    std::vector<float> silence;
    std::vector<AudioData> silentPackets;
    {
        std::string_view referenceId;
        for (const auto& s : audioStreams) if (s.present) { referenceId = s.id; break; }

        uint32_t cadence = 480;   // 10ms at 48kHz, WASAPI's usual packet
        for (const auto& p : audioPackets)
            if (p.sourceId == referenceId && p.frameCount) { cadence = p.frameCount; break; }

        // Every audio stream has to span the whole clip. IMFSinkWriter waits for
        // the one that does not, video runs on to the end, Finalize is never
        // reached, and saveClip hangs with no error - the hotkey simply stops
        // working for the rest of the session.
        //
        // Audio can be missing at the head (switched on partway through), in the
        // middle (one source stopped), or at the tail (switched off partway).
        // The Audio capture switch in Settings produces all three, so rather
        // than patching each, lay a grid of slots across the video's whole span
        // and let the sweep below skip wherever a track really has samples.
        struct Slot { int64_t timeUs; uint32_t frameCount; };
        std::vector<Slot> grid;
        if (fallbackRate) {
            int64_t videoStartUs = videoPackets.front().pts_us;
            int64_t videoEndUs = videoStartUs;
            for (const auto& p : videoPackets) {
                videoStartUs = (std::min)(videoStartUs, p.pts_us);
                videoEndUs = (std::max)(videoEndUs, p.pts_us);
            }
            const int64_t step = (std::max)(
                static_cast<int64_t>(1), static_cast<int64_t>(cadence) * 1000000 / fallbackRate);
            // Bounded by the video's own length, so a bad timestamp cannot spin
            // this: a 600s clip at 10ms is 60000 slots.
            for (int64_t at = videoStartUs; at <= videoEndUs && grid.size() < 200000u; at += step) {
                grid.push_back({at, cadence});
            }
        }

        size_t widest = 0;
        for (const auto& s : audioStreams) {
            if (!s.channels) continue;
            widest = (std::max)(widest, static_cast<size_t>(cadence) * s.channels);
        }
        silence.assign(widest, 0.0f);

        for (const auto& s : audioStreams) {
            if (!s.channels) continue;
            // What this track already covers, in order, so the sweep is linear
            // rather than a search per slot.
            struct Span { int64_t fromUs, toUs; };
            std::vector<Span> covered;
            for (const auto& p : audioPackets) {
                if (p.sourceId != s.id || !p.samples || !p.sampleRate) continue;
                covered.push_back({p.timestamp_us,
                    p.timestamp_us + static_cast<int64_t>(p.frameCount) * 1000000 / p.sampleRate});
            }
            std::stable_sort(covered.begin(), covered.end(),
                [](const Span& a, const Span& b) { return a.fromUs < b.fromUs; });

            size_t at = 0;
            for (const auto& slot : grid) {
                while (at < covered.size() && covered[at].toUs <= slot.timeUs) ++at;
                const bool inside = at < covered.size() && covered[at].fromUs <= slot.timeUs;
                if (inside) continue;
                silentPackets.push_back({silence.data(), slot.frameCount, s.channels,
                                         s.sampleRate, slot.timeUs, std::string(s.id)});
            }
        }
    }

    for (const auto& p : videoPackets) schedule.push_back({p.pts_us, videoStream, &p, nullptr});
    for (const auto& stream : audioStreams) if (stream.present) {
        for (const auto& p : audioPackets) {
            if (p.sourceId != stream.id || !p.samples || p.channels != stream.channels || p.sampleRate != stream.sampleRate) continue;
            schedule.push_back({p.timestamp_us, stream.index, nullptr, &p});
        }
    }
    for (const auto& p : silentPackets)
        for (const auto& stream : audioStreams)
            if (stream.channels && p.sourceId == stream.id)
                schedule.push_back({p.timestamp_us, stream.index, nullptr, &p});
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
    } catch (...) {
        writer.Reset();

        throw;
    }
    writer.Reset();
    output.Publish();
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
    std::strftime(stamp, sizeof(stamp), "%Y-%m-%d_%H-%M-%S", &local);
    std::string safe = gameName.empty() ? "Unknown" : gameName;
    for (char& c : safe) if (c == '<' || c == '>' || c == ':' || c == '"' || c == '/' || c == '\\' || c == '|' || c == '?' || c == '*') c = '_';
    const auto dir = std::filesystem::u8path(baseDir) / std::filesystem::u8path(safe);
    static std::mutex pathMutex;
    static std::string reservedStamp;
    static std::vector<std::filesystem::path> reserved;
    std::lock_guard lock(pathMutex);
    if (reservedStamp != stamp) { reservedStamp = stamp; reserved.clear(); }
    for (uint32_t counter = 1;; ++counter) {
        const auto name = std::string(stamp) + (counter == 1 ? "" : "_" + std::to_string(counter)) + ".mp4";
        const auto candidate = dir / std::filesystem::u8path(name);
        if (!std::filesystem::exists(candidate) && std::find(reserved.begin(), reserved.end(), candidate) == reserved.end()) {
            reserved.push_back(candidate); return candidate.string();
        }
    }
}

} // namespace flash
