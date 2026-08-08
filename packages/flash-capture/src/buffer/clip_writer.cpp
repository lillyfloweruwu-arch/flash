#include "clip_writer.h"
#include <chrono>
#include <ctime>
#include <filesystem>

#ifdef _WIN32
#include <shlobj.h>
#pragma comment(lib, "shell32.lib")
#endif

namespace flash {

ClipWriter::ClipWriter() = default;
ClipWriter::~ClipWriter() = default;

ClipMetadata ClipWriter::Write(
    const std::string& outputPath,
    const std::vector<EncodedPacket>& videoPackets,
    const std::vector<AudioData>& audioPackets,
    uint32_t width,
    uint32_t height,
    uint32_t fps,
    const std::string& gameName
) {
    ClipMetadata meta;
    meta.filePath = outputPath;
    meta.game = gameName;
    meta.width = width;
    meta.height = height;
    meta.fps = fps;

    auto now = std::chrono::system_clock::now();
    meta.timestamp = std::chrono::duration_cast<std::chrono::seconds>(
        now.time_since_epoch()
    ).count();

    if (!videoPackets.empty()) {
        int64_t firstTs = videoPackets.front().timestamp_us;
        int64_t lastTs = videoPackets.back().timestamp_us;
        meta.durationSeconds = static_cast<uint32_t>((lastTs - firstTs) / 1000000);
    }

    // TODO: Use Media Foundation Sink Writer to mux H.264 + AAC into MP4
    // Steps:
    // 1. MFCreateSinkWriterFromURL(outputPath)
    // 2. Add video stream (H.264)
    // 3. Add audio stream (AAC)
    // 4. BeginWriting
    // 5. WriteSample for each video packet
    // 6. WriteSample for each audio packet (interleaved by timestamp)
    // 7. Finalize

    // Ensure output directory exists
    std::filesystem::create_directories(
        std::filesystem::path(outputPath).parent_path()
    );

    // Stub: write raw H.264 for now (can be played by ffplay/VLC)
    // Real implementation needs proper MP4 container
    FILE* f = fopen(outputPath.c_str(), "wb");
    if (f) {
        for (const auto& pkt : videoPackets) {
            fwrite(pkt.data.data(), 1, pkt.data.size(), f);
        }
        fclose(f);
    }

    return meta;
}

std::string ClipWriter::GenerateClipPath(const std::string& baseDir, const std::string& gameName) {
    auto now = std::chrono::system_clock::now();
    auto time = std::chrono::system_clock::to_time_t(now);
    struct tm tm;
    localtime_s(&tm, &time);

    char buf[256];
    snprintf(buf, sizeof(buf), "%s/%s/%04d-%02d-%02d_%02d-%02d-%02d.mp4",
        baseDir.c_str(),
        gameName.c_str(),
        tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
        tm.tm_hour, tm.tm_min, tm.tm_sec
    );

    return std::string(buf);
}

} // namespace flash
