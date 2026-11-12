// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include "../../core/capture_clock.h"
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/buffers.h>
#include <algorithm>
#include <mutex>
#include <thread>
#include <stdexcept>
#include <vector>

namespace flash {
namespace {
// BT.709 NV12 to packed BGRx. PipeWire screencast rarely negotiates NV12, but
// some compositors offer nothing else, so a frame in that format is converted
// here rather than dropped.
uint8_t ClampByte(int value) { return static_cast<uint8_t>(std::clamp(value, 0, 255)); }

class PipeWireVideo final : public VideoSource {
    std::atomic<bool> running_{false}, healthy_{false};
    std::atomic<bool> pending_{false};
    std::atomic<bool> ended_{false}, connected_{false}, producedFrame_{false};
    std::atomic<bool> shmRequested_{false};
    std::thread thread_;
    GCancellable* cancel_ = g_cancellable_new();
    mutable std::mutex mutex_;
    std::string error_;
    FrameCallback callback_;
    std::atomic<uint32_t> width_{1920}, height_{1080}, fps_{60};
    pw_stream* stream_ = nullptr;
    spa_video_info_raw format_{};
    int64_t lastFrame_ = -1000000;
    std::vector<uint8_t> latestPixels_;
    FrameData latest_{};
    std::vector<uint8_t> converted_;

    // SHM only for now. DMA-BUF import needs modifiers, fences and encoder-owned
    // surfaces (L2); if a server sends DMA-BUF anyway, ask for SHM again.
    void RequestBuffers() {
        if (!stream_) return;
        uint8_t bytes[256]; auto builder = SPA_POD_BUILDER_INIT(bytes, sizeof(bytes));
        const spa_pod* params[] = {static_cast<spa_pod*>(spa_pod_builder_add_object(&builder,
            SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
            SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemFd) | (1 << SPA_DATA_MemPtr))))};
        pw_stream_update_params(stream_, params, 1);
    }
    static void Format(void* data, uint32_t id, const spa_pod* pod) {
        auto& self = *static_cast<PipeWireVideo*>(data);
        if (id == SPA_PARAM_Format && pod && spa_format_video_raw_parse(pod, &self.format_) >= 0) {
            // The portal picks the source size, not the display list. Keep the
            // reported size in step with the format the server negotiated.
            if (self.format_.size.width && self.format_.size.height) {
                self.width_ = self.format_.size.width; self.height_ = self.format_.size.height;
            }
            self.RequestBuffers();
        }
    }
    static void State(void* data, pw_stream_state, pw_stream_state state, const char* error) {
        auto& self = *static_cast<PipeWireVideo*>(data);
        if (state == PW_STREAM_STATE_STREAMING || state == PW_STREAM_STATE_PAUSED) {
            self.connected_ = true;
            return;
        }
        if (state == PW_STREAM_STATE_ERROR || (state == PW_STREAM_STATE_UNCONNECTED && self.connected_)) {
            std::lock_guard lock(self.mutex_);
            self.healthy_ = false; self.error_ = error && *error ? error : "Screen sharing stream ended";
            self.ended_ = true;
        }
    }
    bool ConvertNv12(const spa_data* datas, uint32_t count, uint32_t width, uint32_t height) {
        const auto& yPlane = datas[0];
        if (!yPlane.data || !yPlane.chunk) return false;
        int32_t yStride = yPlane.chunk->stride;
        if (yStride <= 0) yStride = static_cast<int32_t>(width);
        if (static_cast<uint32_t>(yStride) < width) return false;
        if (static_cast<uint64_t>(yPlane.chunk->offset) + static_cast<uint64_t>(yStride) * height > yPlane.maxsize) return false;
        const auto* y = static_cast<const uint8_t*>(yPlane.data) + yPlane.chunk->offset;
        const uint32_t chromaHeight = (height + 1) / 2;
        const uint8_t* uv = nullptr; int32_t uvStride = yStride;
        if (count >= 2 && datas[1].data && datas[1].chunk) {
            uvStride = datas[1].chunk->stride > 0 ? datas[1].chunk->stride : static_cast<int32_t>(width);
            if (static_cast<uint32_t>(uvStride) < width) return false;
            if (static_cast<uint64_t>(datas[1].chunk->offset) + static_cast<uint64_t>(uvStride) * chromaHeight > datas[1].maxsize) return false;
            uv = static_cast<const uint8_t*>(datas[1].data) + datas[1].chunk->offset;
        } else {
            // Single-plane NV12 keeps the interleaved chroma after the luma.
            const uint64_t offset = static_cast<uint64_t>(yPlane.chunk->offset) + static_cast<uint64_t>(yStride) * height;
            if (offset + static_cast<uint64_t>(uvStride) * chromaHeight > yPlane.maxsize) return false;
            uv = static_cast<const uint8_t*>(yPlane.data) + offset;
        }
        converted_.resize(static_cast<size_t>(width) * height * 4);
        const bool fullRange = format_.color_range == SPA_VIDEO_COLOR_RANGE_0_255;
        for (uint32_t row = 0; row < height; ++row) {
            const auto* yRow = y + static_cast<size_t>(row) * yStride;
            const auto* uvRow = uv + static_cast<size_t>(row / 2) * uvStride;
            auto* out = converted_.data() + static_cast<size_t>(row) * width * 4;
            for (uint32_t x = 0; x < width; ++x) {
                const int Y = yRow[x];
                const int U = static_cast<int>(uvRow[(x / 2) * 2]) - 128;
                const int V = static_cast<int>(uvRow[(x / 2) * 2 + 1]) - 128;
                int r, g, b;
                if (fullRange) {
                    r = (256 * Y + 403 * V + 128) >> 8;
                    g = (256 * Y - 48 * U - 120 * V + 128) >> 8;
                    b = (256 * Y + 475 * U + 128) >> 8;
                } else {
                    const int c = (Y - 16) * 298;
                    r = (c + 459 * V + 128) >> 8;
                    g = (c - 55 * U - 136 * V + 128) >> 8;
                    b = (c + 541 * U + 128) >> 8;
                }
                out[x * 4] = ClampByte(b); out[x * 4 + 1] = ClampByte(g);
                out[x * 4 + 2] = ClampByte(r); out[x * 4 + 3] = 255;
            }
        }
        return true;
    }
    void Deliver(const FrameData& frame) {
        try {
            callback_(frame); healthy_ = true; lastFrame_ = frame.timestamp_us; producedFrame_ = true;
            std::lock_guard lock(mutex_);
            error_.clear();
            latestPixels_.assign(frame.data, frame.data + static_cast<size_t>(frame.stride) * frame.height);
            latest_ = frame; latest_.data = nullptr;
        }
        catch (const std::exception& e) { std::lock_guard lock(mutex_); error_ = e.what(); healthy_ = false; }
    }
    static void Process(void* data) {
        auto& self = *static_cast<PipeWireVideo*>(data);
        auto* buffer = pw_stream_dequeue_buffer(self.stream_);
        if (!buffer) return;
        const auto* b = buffer->buffer;
        const auto now = CaptureClockUs();
        if (b->n_datas && self.format_.size.width && self.format_.size.height && now - self.lastFrame_ >= 1000000 / self.fps_) {
            const auto& plane = b->datas[0];
            if (plane.type != SPA_DATA_MemFd && plane.type != SPA_DATA_MemPtr) {
                // The server ignored the SHM request. Re-ask once; the next
                // buffers should arrive as memfd or mapped memory.
                if (!self.shmRequested_.exchange(true)) self.RequestBuffers();
            } else if (plane.data && plane.chunk) {
                const uint32_t width = self.format_.size.width, height = self.format_.size.height;
                FrameData frame{};
                frame.width = width; frame.height = height; frame.timestamp_us = now;
                if (self.format_.format == SPA_VIDEO_FORMAT_NV12) {
                    if (self.ConvertNv12(b->datas, b->n_datas, width, height)) {
                        frame.data = self.converted_.data(); frame.stride = width * 4; frame.rgb = false;
                        self.Deliver(frame);
                    }
                } else if (self.format_.format == SPA_VIDEO_FORMAT_BGRx || self.format_.format == SPA_VIDEO_FORMAT_BGRA ||
                           self.format_.format == SPA_VIDEO_FORMAT_RGBx || self.format_.format == SPA_VIDEO_FORMAT_RGBA) {
                    const auto stride = plane.chunk->stride;
                    if (stride > 0 && static_cast<uint64_t>(stride) >= static_cast<uint64_t>(width) * 4 &&
                        plane.chunk->size >= static_cast<uint64_t>(stride) * height &&
                        static_cast<uint64_t>(plane.chunk->offset) + static_cast<uint64_t>(stride) * height <= plane.maxsize) {
                        frame.data = static_cast<uint8_t*>(plane.data) + plane.chunk->offset;
                        frame.stride = stride;
                        frame.rgb = self.format_.format == SPA_VIDEO_FORMAT_RGBx || self.format_.format == SPA_VIDEO_FORMAT_RGBA;
                        self.Deliver(frame);
                    }
                }
            }
        }
        pw_stream_queue_buffer(self.stream_, buffer);
    }
    bool Session() {
        auto* loop = nullptr; pw_context* pwContext = nullptr; pw_core* core = nullptr;
        spa_hook listener{}; bool attached = false; bool retry = false;
        ended_ = false; connected_ = false; producedFrame_ = false; shmRequested_ = false;
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
                uint8_t bytes[2048]; auto builder = SPA_POD_BUILDER_INIT(bytes, sizeof(bytes));
                spa_video_info_raw info{};
                // Ask for the formats a screencast backend can plausibly send,
                // in order of what is cheapest to hand to the encoder. NV12 is
                // converted above; the rest are already packed BGRx/RGBx.
                const enum spa_video_format formats[] = {SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRA,
                    SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_RGBA, SPA_VIDEO_FORMAT_NV12};
                const spa_pod* params[sizeof(formats) / sizeof(formats[0])];
                for (size_t i = 0; i < sizeof(formats) / sizeof(formats[0]); ++i) {
                    info.format = formats[i];
                    params[i] = spa_format_video_raw_build(&builder, SPA_PARAM_EnumFormat, &info);
                }
                // L1 uses mapped SHM with CPU conversion. L2 must negotiate
                // modifiers and import DMA-BUF planes into encoder-owned NV12
                // surfaces, preserving acquire/release fences and buffer lifetime.
                if (pw_stream_connect(stream_, PW_DIRECTION_INPUT, portal.serial.empty() ? portal.node : PW_ID_ANY,
                    static_cast<pw_stream_flags>(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS),
                    params, sizeof(params) / sizeof(params[0])) < 0)
                    throw std::runtime_error("Could not connect video stream");
                pending_ = false;
                lastFrame_ = CaptureClockUs();
                while (running_ && !ended_) {
                    pw_loop_iterate(pw_main_loop_get_loop(loop), 50);
                    if (lastFrame_ >= 0 && CaptureClockUs() - lastFrame_ > 5000000) {
                        std::lock_guard lock(mutex_); healthy_ = false; error_ = "No PipeWire video frames for five seconds";
                    }
                }
                if (ended_ && running_) {
                    std::lock_guard lock(mutex_);
                    if (error_.empty()) error_ = "Screen sharing ended; reconnecting";
                    retry = true;
                }
            } catch (const std::exception& e) {
                const std::string message = e.what();
                { std::lock_guard lock(mutex_); error_ = message; healthy_ = false; }
                // A dismissed picker is the user saying no, not a dropped
                // session; do not reopen it behind their back.
                retry = running_ && message.find("cancelled") == std::string::npos && message.find("denied") == std::string::npos;
            }
            healthy_ = false;
            if (attached) spa_hook_remove(&listener);
            if (stream_) { pw_stream_destroy(stream_); stream_ = nullptr; }
            if (core) pw_core_disconnect(core);
            if (pwContext) pw_context_destroy(pwContext);
            if (loop) pw_main_loop_destroy(loop);
        }
        return retry;
    }
    void Run() {
        auto* context = g_main_context_new(); g_main_context_push_thread_default(context);
        int failures = 0;
        while (running_) {
            pending_ = true;
            const bool retry = Session();
            if (!running_) break;
            if (!retry) break;
            // A session that delivered frames is a real drop, not a broken
            // restore loop. Only give up after repeated failures with no video.
            if (producedFrame_) failures = 0;
            if (++failures > 5) {
                std::lock_guard lock(mutex_); healthy_ = false;
                if (error_.empty()) error_ = "Screen sharing kept ending; stopped capture";
                break;
            }
            for (int i = 0; i < 20 && running_; ++i) g_usleep(100000);
        }
        healthy_ = false; running_ = false; pending_ = false;
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
