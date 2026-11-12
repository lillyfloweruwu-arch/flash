// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include "../../core/capture_clock.h"
#include <pipewire/pipewire.h>
#include <pipewire/node.h>
#include <pipewire/proxy.h>
#include <spa/param/audio/format-utils.h>
#include <array>
#include <chrono>
#include <cstring>
#include <thread>
#include <mutex>
#include <algorithm>

namespace flash {
namespace {
struct SourceScan {
    std::vector<AudioDeviceInfo> devices;
    int pending = -1;
    bool done = false;
};
// Audio/Source nodes are microphones. Sinks also have monitor sources, which
// are loopbacks of what is playing and not something the user talks into.
void RegistryGlobal(void* data, uint32_t, uint32_t, const char* type, uint32_t, const spa_dict* props) {
    auto& scan = *static_cast<SourceScan*>(data);
    if (!type || std::strcmp(type, PW_TYPE_INTERFACE_Node) != 0 || !props) return;
    const char* mediaClass = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    if (!mediaClass || std::strcmp(mediaClass, "Audio/Source") != 0) return;
    const char* name = spa_dict_lookup(props, PW_KEY_NODE_NAME);
    if (!name || !*name) return;
    const std::string id(name);
    if (id.size() > 8 && id.compare(id.size() - 8, 8, ".monitor") == 0) return;
    const char* deviceClass = spa_dict_lookup(props, "device.class");
    if (deviceClass && std::strcmp(deviceClass, "monitor") == 0) return;
    if (std::any_of(scan.devices.begin(), scan.devices.end(), [&](const AudioDeviceInfo& device) { return device.id == id; })) return;
    const char* description = spa_dict_lookup(props, PW_KEY_NODE_DESCRIPTION);
    if (!description || !*description) description = spa_dict_lookup(props, PW_KEY_NODE_NICK);
    AudioDeviceInfo info;
    info.id = id;
    info.name = description && *description ? description : id;
    scan.devices.push_back(std::move(info));
}
void CoreDone(void* data, uint32_t id, int seq) {
    auto& scan = *static_cast<SourceScan*>(data);
    if (id == PW_ID_CORE && seq == scan.pending) scan.done = true;
}
std::vector<AudioDeviceInfo> ListPipeWireSources() {
    std::vector<AudioDeviceInfo> result;
    pw_init(nullptr, nullptr);
    auto* loop = pw_main_loop_new(nullptr);
    if (!loop) return result;
    auto* context = pw_context_new(pw_main_loop_get_loop(loop), nullptr, 0);
    if (!context) { pw_main_loop_destroy(loop); return result; }
    auto* core = pw_context_connect(context, nullptr, 0);
    if (!core) { pw_context_destroy(context); pw_main_loop_destroy(loop); return result; }
    auto* registry = pw_core_get_registry(core, PW_VERSION_REGISTRY, 0);
    if (!registry) { pw_core_disconnect(core); pw_context_destroy(context); pw_main_loop_destroy(loop); return result; }
    SourceScan scan;
    static const pw_registry_events registryEvents = [] { pw_registry_events e{}; e.version = PW_VERSION_REGISTRY_EVENTS;
        e.global = RegistryGlobal; return e; }();
    static const pw_core_events coreEvents = [] { pw_core_events e{}; e.version = PW_VERSION_CORE_EVENTS;
        e.done = CoreDone; return e; }();
    spa_hook registryHook{}, coreHook{};
    pw_registry_add_listener(registry, &registryHook, &registryEvents, &scan);
    pw_core_add_listener(core, &coreHook, &coreEvents, &scan);
    scan.pending = pw_core_sync(core, PW_ID_CORE, 0);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!scan.done && std::chrono::steady_clock::now() < deadline)
        pw_loop_iterate(pw_main_loop_get_loop(loop), 100);
    spa_hook_remove(&registryHook); spa_hook_remove(&coreHook);
    result = std::move(scan.devices);
    pw_proxy_destroy(reinterpret_cast<pw_proxy*>(registry));
    pw_core_disconnect(core); pw_context_destroy(context); pw_main_loop_destroy(loop);
    return result;
}
class PipeWireAudio final : public AudioSource {
    struct Track {
        PipeWireAudio* owner = nullptr;
        pw_stream* stream = nullptr;
        std::string id;
        bool enabled = true;
        float gain = 1;
        bool active = false;
        std::string error;
    };
    std::array<Track, 2> tracks_;
    pw_main_loop* loop_ = nullptr;
    std::thread thread_;
    std::atomic<bool> running_{false};
    mutable std::mutex mutex_;
    AudioCallback callback_;
    std::string micDeviceId_;
    static void State(void* data, pw_stream_state, pw_stream_state state, const char* error) {
        auto& track = *static_cast<Track*>(data); std::lock_guard lock(track.owner->mutex_);
        track.active = state == PW_STREAM_STATE_STREAMING;
        track.error = error ? error : "";
    }
    static void Process(void* data) {
        auto& track = *static_cast<Track*>(data); auto& self = *track.owner;
        auto* buffer = pw_stream_dequeue_buffer(track.stream); if (!buffer) return;
        const auto* b = buffer->buffer;
        bool enabled; float gain;
        { std::lock_guard lock(self.mutex_); enabled = track.enabled; gain = track.gain; }
        if (enabled && b->n_datas && b->datas[0].data && b->datas[0].chunk) {
            const auto& plane = b->datas[0];
            const uint32_t size = plane.chunk->size, offset = plane.chunk->offset;
            if (offset <= plane.maxsize && size <= plane.maxsize - offset) {
                const auto frames = size / (2 * sizeof(float));
                const auto* input = reinterpret_cast<const float*>(static_cast<const uint8_t*>(plane.data) + offset);
                std::vector<float> samples(input, input + frames * 2);
                for (auto& sample : samples) sample *= gain;
                // L1: common monotonic clock, corrected for block length. L2
                // must measure graph/device latency and default-device switches.
                AudioData audio{samples.data(), static_cast<uint32_t>(frames), 2, 48000,
                    CaptureClockUs() - static_cast<int64_t>(frames) * 1000000 / 48000, track.id};
                try { self.callback_(audio); }
                catch (...) { std::lock_guard lock(self.mutex_); track.error = "Audio delivery failed"; }
            }
        }
        pw_stream_queue_buffer(track.stream, buffer);
    }
public:
    PipeWireAudio() { tracks_[0].id = "other"; tracks_[1].id = "mic"; for (auto& track : tracks_) track.owner = this; }
    ~PipeWireAudio() override { Stop(); }
    bool Initialize() override { pw_init(nullptr, nullptr); return true; }
    bool SetGameProcess(uint32_t) override { return false; }
    bool Start(AudioCallback callback) override {
        Stop(); callback_ = std::move(callback); loop_ = pw_main_loop_new(nullptr);
        if (!loop_) return false;
        static const pw_stream_events events = [] { pw_stream_events e{}; e.version = PW_VERSION_STREAM_EVENTS;
            e.state_changed = State; e.process = Process; return e; }();
        std::string mic;
        { std::lock_guard lock(mutex_); mic = micDeviceId_; }
        for (auto& track : tracks_) {
            auto* props = pw_properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Capture",
                PW_KEY_MEDIA_ROLE, "Production", "stream.capture.sink", track.id == "other" ? "true" : "false", nullptr);
            // Empty means the session manager's default source.
            if (track.id == "mic" && !mic.empty()) pw_properties_set(props, PW_KEY_TARGET_OBJECT, mic.c_str());
            track.stream = pw_stream_new_simple(pw_main_loop_get_loop(loop_), "Flash audio", props, &events, &track);
            if (!track.stream) { Stop(); return false; }
            uint8_t bytes[512]; auto builder = SPA_POD_BUILDER_INIT(bytes, sizeof(bytes));
            spa_audio_info_raw format{}; format.format = SPA_AUDIO_FORMAT_F32; format.rate = 48000; format.channels = 2;
            format.position[0] = SPA_AUDIO_CHANNEL_FL; format.position[1] = SPA_AUDIO_CHANNEL_FR;
            const spa_pod* params[] = {spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &format)};
            if (pw_stream_connect(track.stream, PW_DIRECTION_INPUT, PW_ID_ANY,
                static_cast<pw_stream_flags>(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS), params, 1) < 0) {
                Stop(); return false;
            }
        }
        running_ = true;
        thread_ = std::thread([this] { while (running_) pw_loop_iterate(pw_main_loop_get_loop(loop_), 50); });
        return true;
    }
    void Stop() override {
        running_ = false; if (thread_.joinable()) thread_.join();
        for (auto& track : tracks_) if (track.stream) { pw_stream_destroy(track.stream); track.stream = nullptr; track.active = false; }
        if (loop_) { pw_main_loop_destroy(loop_); loop_ = nullptr; }
    }
    bool IsCapturing() const override { return running_; }
    std::vector<AudioSourceInfo> ListSources() const override {
        std::lock_guard lock(mutex_); std::vector<AudioSourceInfo> result;
        for (const auto& track : tracks_) result.push_back({track.id, track.id, track.id == "mic" ? "Default microphone" : "Desktop audio",
            true, track.enabled, track.active, track.gain, 48000, 2, 0, track.error});
        return result;
    }
    bool SetSource(const std::string& id, bool enabled, float gain) override {
        std::lock_guard lock(mutex_);
        for (auto& track : tracks_) if (track.id == id) { track.enabled = enabled; track.gain = gain; return true; }
        return false;
    }
    std::vector<AudioDeviceInfo> ListCaptureDevices() const override { return ListPipeWireSources(); }
    bool SetCaptureDevice(const std::string& id) override {
        AudioCallback callback;
        bool wasCapturing;
        {
            std::lock_guard lock(mutex_);
            if (micDeviceId_ == id) return true;
            micDeviceId_ = id; callback = callback_; wasCapturing = running_;
        }
        // Same as a game change: rebuild the streams so the new mic is used now.
        return wasCapturing ? Start(std::move(callback)) : true;
    }
    std::string GetMode() const override { return "mixed"; }
    std::string GetProcessError() const override { return "Per-app audio is not available on Linux in L1"; }
};
}
std::unique_ptr<AudioSource> CreatePipeWireAudio() { return std::make_unique<PipeWireAudio>(); }
} // namespace flash
