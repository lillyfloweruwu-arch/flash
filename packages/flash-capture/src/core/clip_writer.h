#pragma once

#include "encoder.h"
#include "audio_source.h"
#include <vector>
#include <string>

namespace flash {

struct ClipMetadata {
    std::string filePath;
    std::string game;
    double durationSeconds;
    uint32_t width;
    uint32_t height;
    uint32_t fps;
    int64_t timestamp; // Unix timestamp of clip creation
    double actualStartSeconds = 0.0;
};

// Writes encoded video and audio packets to an MP4 file
class ClipWriter {
public:
    ClipWriter();
    ~ClipWriter();

    // Write packets to MP4 file
    // Returns metadata about the written clip
    ClipMetadata Write(
        const std::string& outputPath,
        const std::vector<EncodedPacket>& videoPackets,
        const std::vector<AudioData>& audioPackets,
        uint32_t width,
        uint32_t height,
        uint32_t fps,
        const std::string& gameName
    );

    // Generate output path based on game name and timestamp
    static std::string GenerateClipPath(const std::string& baseDir, const std::string& gameName);

};

} // namespace flash
