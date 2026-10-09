#include "../../core/platform.h"
#include "screen_capture.h"
#include "audio_capture.h"

namespace flash {
namespace {
class WindowsMuxer final : public ClipMuxer {
public:
    ClipMetadata Write(const std::string& path, const std::vector<EncodedPacket>& video,
        const std::vector<AudioData>& audio, uint32_t width, uint32_t height,
        uint32_t fps, const std::string& game) override {
        return ClipWriter().Write(path, video, audio, width, height, fps, game);
    }
    std::string GenerateClipPath(const std::string& dir, const std::string& game) override {
        return ClipWriter::GenerateClipPath(dir, game);
    }
    ClipMetadata Trim(const std::string& in, const std::string& out, int64_t start, int64_t end) override {
        return TrimClip(in, out, start, end);
    }
    ExportResult Export(const std::string& in, const std::string& out, const ExportOptions& options) override {
        return ExportClip(in, out, options);
    }
    std::vector<DecodedTrack> DecodeAudio(const std::string& path, uint32_t rate) override {
        return DecodeClipAudio(path, rate);
    }
    VideoScan ScanVideo(const std::string& path) override { return ScanClipVideo(path); }
    bool SupportsSmartRender() const override { return true; }
};
class WindowsProcesses final : public ProcessLister {
public:
    ProcessSnapshot List() override { return ListProcesses(); }
};
}
std::shared_ptr<VideoSource> CreateVideoSource() { return std::make_shared<ScreenCapture>(); }
std::unique_ptr<AudioSource> CreateAudioSource() { return std::make_unique<AudioCapture>(); }
std::unique_ptr<ClipMuxer> CreateClipMuxer() { return std::make_unique<WindowsMuxer>(); }
std::unique_ptr<ProcessLister> CreateProcessLister() { return std::make_unique<WindowsProcesses>(); }
std::vector<DisplayInfo> ListPlatformDisplays() { return ScreenCapture::ListDisplays(); }
void SetPortalRestoreToken(const std::string&, std::function<void(const std::string&)>) {}
} // namespace flash
