// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include "../../core/capture_clock.h"
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <array>
#include <thread>
#include <mutex>
#include <algorithm>

namespace flash {
namespace {
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
        for (auto& track : tracks_) {
            auto* props = pw_properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Capture",
                PW_KEY_MEDIA_ROLE, "Production", "stream.capture.sink", track.id == "other" ? "true" : "false", nullptr);
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
    std::string GetMode() const override { return "mixed"; }
    std::string GetProcessError() const override { return "Per-app audio is not available on Linux in L1"; }
};
}
std::unique_ptr<AudioSource> CreatePipeWireAudio() { return std::make_unique<PipeWireAudio>(); }
} // namespace flash
