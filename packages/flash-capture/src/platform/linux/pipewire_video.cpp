// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include "../../core/capture_clock.h"
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/buffers.h>
#include <mutex>
#include <thread>
#include <stdexcept>

namespace flash {
namespace {
class PipeWireVideo final : public VideoSource {
    std::atomic<bool> running_{false}, healthy_{false};
    std::atomic<bool> pending_{false};
    std::thread thread_;
    GCancellable* cancel_ = g_cancellable_new();
    mutable std::mutex mutex_;
    std::string error_;
    FrameCallback callback_;
    uint32_t width_ = 1920, height_ = 1080, fps_ = 60;
    pw_stream* stream_ = nullptr;
    spa_video_info_raw format_{};
    int64_t lastFrame_ = -1000000;
    std::vector<uint8_t> latestPixels_;
    FrameData latest_{};

    static void Format(void* data, uint32_t id, const spa_pod* pod) {
        auto& self = *static_cast<PipeWireVideo*>(data);
        if (id == SPA_PARAM_Format && pod && spa_format_video_raw_parse(pod, &self.format_) >= 0) {
            uint8_t bytes[256]; auto builder = SPA_POD_BUILDER_INIT(bytes, sizeof(bytes));
            const spa_pod* params[] = {static_cast<spa_pod*>(spa_pod_builder_add_object(&builder,
                SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
                SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemFd) | (1 << SPA_DATA_MemPtr))))};
            pw_stream_update_params(self.stream_, params, 1);
        }
    }
    static void State(void* data, pw_stream_state, pw_stream_state state, const char* error) {
        auto& self = *static_cast<PipeWireVideo*>(data);
        if (state == PW_STREAM_STATE_ERROR || state == PW_STREAM_STATE_UNCONNECTED) {
            std::lock_guard lock(self.mutex_);
            self.healthy_ = false; self.error_ = error ? error : "PipeWire video disconnected";
        }
    }
    static void Process(void* data) {
        auto& self = *static_cast<PipeWireVideo*>(data);
        auto* buffer = pw_stream_dequeue_buffer(self.stream_);
        if (!buffer) return;
        const auto* b = buffer->buffer;
        const auto now = CaptureClockUs();
        if (b->n_datas && self.format_.size.width && now - self.lastFrame_ >= 1000000 / self.fps_) {
            const auto& plane = b->datas[0];
            if (plane.data && plane.chunk && plane.chunk->stride > 0 &&
                static_cast<uint64_t>(plane.chunk->stride) >= static_cast<uint64_t>(self.format_.size.width) * 4 &&
                plane.chunk->size >= static_cast<uint64_t>(plane.chunk->stride) * self.format_.size.height &&
                (self.format_.format == SPA_VIDEO_FORMAT_BGRx || self.format_.format == SPA_VIDEO_FORMAT_RGBx) &&
                static_cast<uint64_t>(plane.chunk->offset) + static_cast<uint64_t>(plane.chunk->stride) * self.format_.size.height <= plane.maxsize) {
                FrameData frame{};
                frame.data = static_cast<uint8_t*>(plane.data) + plane.chunk->offset;
                frame.width = self.format_.size.width; frame.height = self.format_.size.height;
                frame.stride = plane.chunk->stride; frame.timestamp_us = now;
                frame.rgb = self.format_.format == SPA_VIDEO_FORMAT_RGBx;
                try {
                    self.callback_(frame); self.healthy_ = true; self.lastFrame_ = now;
                    std::lock_guard lock(self.mutex_);
                    self.latestPixels_.assign(frame.data, frame.data + static_cast<size_t>(frame.stride) * frame.height);
                    self.latest_ = frame; self.latest_.data = nullptr;
                }
                catch (const std::exception& e) { std::lock_guard lock(self.mutex_); self.error_ = e.what(); self.healthy_ = false; }
            }
        }
        pw_stream_queue_buffer(self.stream_, buffer);
    }
    void Run() {
        auto* context = g_main_context_new(); g_main_context_push_thread_default(context);
        pw_main_loop* loop = nullptr; pw_context* pwContext = nullptr; pw_core* core = nullptr;
        spa_hook listener{}; bool attached = false;
        {
            PortalSession portal;
            try {
                portal.Open(cancel_);
                pw_init(nullptr, nullptr);
                loop = pw_main_loop_new(nullptr);
                if (!loop) throw std::runtime_error("Could not create PipeWire loop");
                pwContext = pw_context_new(pw_main_loop_get_loop(loop), nullptr, 0);
                if (!pwContext) throw std::runtime_error("Could not create PipeWire context");
                core = pw_context_connect_fd(pwContext, portal.TakeFd(), nullptr, 0);
                if (!core) throw std::runtime_error("Could not connect to portal PipeWire remote");
                auto* properties = pw_properties_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY, "Capture", nullptr);
                if (!portal.serial.empty()) pw_properties_set(properties, PW_KEY_TARGET_OBJECT, portal.serial.c_str());
                stream_ = pw_stream_new(core, "Flash screen", properties);
                if (!stream_) throw std::runtime_error("Could not create video stream");
                static const pw_stream_events events = [] { pw_stream_events e{}; e.version = PW_VERSION_STREAM_EVENTS;
                    e.state_changed = State; e.param_changed = Format; e.process = Process; return e; }();
                pw_stream_add_listener(stream_, &listener, &events, this); attached = true;
                uint8_t bytes[1024]; auto builder = SPA_POD_BUILDER_INIT(bytes, sizeof(bytes));
                spa_video_info_raw info{}; info.format = SPA_VIDEO_FORMAT_BGRx;
                const spa_pod* params[2]; params[0] = spa_format_video_raw_build(&builder, SPA_PARAM_EnumFormat, &info);
                info.format = SPA_VIDEO_FORMAT_RGBx; params[1] = spa_format_video_raw_build(&builder, SPA_PARAM_EnumFormat, &info);
                // L1 uses mapped SHM with CPU conversion. L2 must negotiate
                // modifiers and import DMA-BUF planes into encoder-owned NV12
                // surfaces, preserving acquire/release fences and buffer lifetime.
                if (pw_stream_connect(stream_, PW_DIRECTION_INPUT, portal.serial.empty() ? portal.node : PW_ID_ANY,
                    static_cast<pw_stream_flags>(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS), params, 2) < 0)
                    throw std::runtime_error("Could not connect video stream");
                pending_ = false;
                lastFrame_ = CaptureClockUs();
                while (running_) {
                    pw_loop_iterate(pw_main_loop_get_loop(loop), 50);
                    if (lastFrame_ >= 0 && CaptureClockUs() - lastFrame_ > 5000000) {
                        std::lock_guard lock(mutex_); healthy_ = false; error_ = "No PipeWire video frames for five seconds";
                    }
                }
            } catch (const std::exception& e) { std::lock_guard lock(mutex_); error_ = e.what(); }
            healthy_ = false; running_ = false; pending_ = false;
            if (attached) spa_hook_remove(&listener);
            if (stream_) { pw_stream_destroy(stream_); stream_ = nullptr; }
            if (core) pw_core_disconnect(core);
            if (pwContext) pw_context_destroy(pwContext);
            if (loop) pw_main_loop_destroy(loop);
        }
        g_main_context_pop_thread_default(context); g_main_context_unref(context);
    }
public:
    ~PipeWireVideo() override { Stop(); g_object_unref(cancel_); }
    bool Initialize(uint32_t fps, uint32_t width, uint32_t height, uint32_t) override {
        fps_ = fps; width_ = width; height_ = height; return fps && width && height;
    }
    bool Start(FrameCallback callback) override {
        Stop(); g_cancellable_reset(cancel_); callback_ = std::move(callback); lastFrame_ = -1000000;
        { std::lock_guard lock(mutex_); error_.clear(); latestPixels_.clear(); }
        pending_ = true; running_ = true; thread_ = std::thread([this] { Run(); }); return true;
    }
    void Stop() override { running_ = false; g_cancellable_cancel(cancel_); if (thread_.joinable()) thread_.join(); }
    void SaveScreenshot(const std::string& path) override {
        std::vector<uint8_t> pixels; FrameData frame{};
        { std::lock_guard lock(mutex_); pixels = latestPixels_; frame = latest_; }
        if (pixels.empty()) throw std::runtime_error("No screen frame available yet");
        frame.data = pixels.data(); WriteLinuxPng(path, frame);
    }
    bool IsCapturing() const override { return running_; }
    bool IsHealthy() const override { return healthy_; }
    bool IsPending() const override { return pending_; }
    std::string GetCaptureError() const override { std::lock_guard lock(mutex_); return error_; }
    std::string GetCaptureBackend() const override { return "portal-pipewire (L1, untested on hardware)"; }
    uint32_t GetWidth() const override { return width_; }
    uint32_t GetHeight() const override { return height_; }
    uint32_t GetOutputWidth() const override { return width_; }
    uint32_t GetOutputHeight() const override { return height_; }
    void SetGpuOutputEnabled(bool) override {}
    bool HasGpuOutput() const override { return false; }
    void* GetDevice() const override { return nullptr; }
};
}
std::shared_ptr<VideoSource> CreatePipeWireVideo() { return std::make_shared<PipeWireVideo>(); }
} // namespace flash
