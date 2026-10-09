#pragma once
#include "video_source.h"
#include "audio_source.h"
#include "encoder.h"
#include "clip_writer.h"
#include "clip_trimmer.h"
#include "clip_exporter.h"
#include "audio_decode.h"
#include "smart_render.h"
#include "process_list.h"
#include <memory>

namespace flash {
class ClipMuxer {
public:
    virtual ~ClipMuxer() = default;
    virtual ClipMetadata Write(const std::string&, const std::vector<EncodedPacket>&,
        const std::vector<AudioData>&, uint32_t, uint32_t, uint32_t, const std::string&) = 0;
    virtual std::string GenerateClipPath(const std::string&, const std::string&) = 0;
    virtual ClipMetadata Trim(const std::string&, const std::string&, int64_t, int64_t) = 0;
    virtual ExportResult Export(const std::string&, const std::string&, const ExportOptions&) = 0;
    virtual std::vector<DecodedTrack> DecodeAudio(const std::string&, uint32_t) = 0;
    virtual VideoScan ScanVideo(const std::string&) = 0;
    virtual bool SupportsSmartRender() const = 0;
};

std::shared_ptr<VideoSource> CreateVideoSource();
std::unique_ptr<AudioSource> CreateAudioSource();
std::unique_ptr<ClipMuxer> CreateClipMuxer();
std::unique_ptr<ProcessLister> CreateProcessLister();
std::vector<DisplayInfo> ListPlatformDisplays();
// Tokens restore permission only. JavaScript owns persistence in userData.
void SetPortalRestoreToken(const std::string&, std::function<void(const std::string&)>);
} // namespace flash
