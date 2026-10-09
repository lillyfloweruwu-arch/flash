// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include "../../core/voice_trigger.h"

namespace flash {
std::shared_ptr<VideoSource> CreateVideoSource() { return CreatePipeWireVideo(); }
std::unique_ptr<AudioSource> CreateAudioSource() { return CreatePipeWireAudio(); }
std::unique_ptr<ClipMuxer> CreateClipMuxer() { CheckLibavLicense(); return CreateLibavMuxer(); }
std::vector<DisplayInfo> ListPlatformDisplays() {
    // The portal chooses the source after permission. These dimensions are the
    // initial encode ceiling; PipeWire frames supply the actual source size.
    return {{0, "Choose a screen or window (portal)", 1920, 1080, true, 60}};
}
struct VoiceTrigger::Impl {};
VoiceTrigger::VoiceTrigger() = default;
VoiceTrigger::~VoiceTrigger() = default;
void VoiceTrigger::SetEnabled(bool) noexcept {}
bool VoiceTrigger::SetPhrases(const std::vector<std::string>&) noexcept { return false; }
void VoiceTrigger::SetThreshold(double, uint32_t) noexcept {}
VoiceStatus VoiceTrigger::GetStatus() const noexcept { return {false, "", "Voice activation is not available on Linux. Use a hotkey or compositor shortcut."}; }
void VoiceTrigger::SetCallback(CommandCallback) noexcept {}
} // namespace flash
