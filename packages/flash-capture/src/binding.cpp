#include <napi.h>
#include "capture/screen_capture.h"
#include "capture/audio_capture.h"
#include "capture/voice_trigger.h"
#include "encoding/encoder.h"
#include "buffer/ring_buffer.h"
#include "buffer/clip_writer.h"
#include "buffer/clip_exporter.h"
#include "buffer/clip_trimmer.h"
#include "buffer/audio_decode.h"
#include "buffer/smart_render.h"
#include "process_list.h"
#include "quality.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <vector>

using namespace flash;

namespace {
struct OwnedAudio { std::vector<float> samples; uint32_t frameCount = 0, channels = 0, sampleRate = 0; int64_t timestampUs = 0; std::string sourceId; };
struct Quality { uint32_t height = 1080, fps = 60, bitrateKbps = 20000; };

std::mutex g_stateMutex, g_encodeMutex;
std::shared_ptr<ScreenCapture> g_screenCapture;
std::unique_ptr<AudioCapture> g_audioCapture;
std::unique_ptr<Encoder> g_encoder;
std::unique_ptr<RingBuffer> g_ringBuffer;
std::deque<OwnedAudio> g_audioBuffer;
std::vector<EncodedPacket> g_previousVideo;
std::vector<OwnedAudio> g_previousAudio;
std::string g_clipsDir, g_currentGame = "Unknown";
uint32_t g_bufferSeconds = 30, g_displayId = 0, g_encodeWidth = 1920, g_encodeHeight = 1080;
uint32_t g_previousWidth = 0, g_previousHeight = 0, g_previousFps = 0;
bool g_awaitingFirstKeyframe = false;
Quality g_quality;
bool g_audioGame = true, g_audioMic = true, g_audioOther = true;
std::string g_pipelineError;
std::unique_ptr<VoiceTrigger> g_voiceTrigger;
VoiceStatus g_voiceFallbackStatus{false, "", "Voice recognition is unavailable."};

struct VoiceCommandEvent {
    std::string phrase;
    double rawConfidence = 0.0;
};

class VoiceCallbackBridge {
public:
    VoiceCallbackBridge(Napi::Env env, const Napi::Function& callback)
        : tsfn_(Napi::ThreadSafeFunction::New(
              env, callback, "Flash voice command", 0, 1)) {
        // A registered callback should not keep Electron alive on its own.
        tsfn_.Unref(env);
    }

    ~VoiceCallbackBridge() { Close(); }

    void Dispatch(const std::string& phrase, double rawConfidence) noexcept {
        // Serialised against Close. Checking the flag and enqueueing were two
        // separate steps, so a Close landing between them aborted the
        // ThreadSafeFunction — releasing its only thread reference — and the
        // call went to a finalised function. NonBlockingCall only queues, so
        // no JavaScript runs under this lock.
        std::lock_guard lock(mutex_);
        if (closed_.load()) return;
        auto* event = new (std::nothrow) VoiceCommandEvent{phrase, rawConfidence};
        if (!event) return;
        const napi_status status = tsfn_.NonBlockingCall(
            event, [](Napi::Env env, Napi::Function callback, VoiceCommandEvent* value) {
                std::unique_ptr<VoiceCommandEvent> event(value);
                callback.Call({
                    Napi::String::New(env, event->phrase),
                    Napi::Number::New(env, event->rawConfidence),
                });
            });
        if (status != napi_ok) delete event;
    }

    void Close() noexcept {
        std::lock_guard lock(mutex_);
        if (!closed_.exchange(true)) tsfn_.Abort();
    }

private:
    Napi::ThreadSafeFunction tsfn_;
    std::mutex mutex_;
    std::atomic<bool> closed_{false};
};

std::shared_ptr<VoiceCallbackBridge> g_voiceCallback;

void StopCapture() {
    ScreenCapture* screen; AudioCapture* audio;
    { std::lock_guard lock(g_stateMutex); screen = g_screenCapture.get(); audio = g_audioCapture.get(); }
    if (screen) screen->Stop(); if (audio) audio->Stop();
}

// Rolling capture timings, surfaced through getStatus(). Cheap to keep, and the
// difference between "the encoder is slow" and "frames never arrive" is not
// guessable from the outside.
std::atomic<int64_t> g_framesDelivered{0}, g_encodeUs{0}, g_intervalUs{0}, g_packetsPushed{0}, g_encodeFailures{0};

// One failed frame is a hiccup worth counting and nothing more. An unbroken
// run of them is a dead encoder, and that used to be invisible: capture stayed
// "healthy", the ring buffer kept whatever it held from before the encoder
// died, and the next hotkey press handed back that old footage as a fresh
// clip. Two seconds at 60fps is far beyond any transient, so this cannot trip
// on a working encoder.
constexpr int kEncoderDeadAfterFrames = 120;
std::atomic<int> g_encodeFailureStreak{0};
std::atomic<bool> g_encoderDead{false};

bool StartCaptureThreads() {
    ScreenCapture* screen; AudioCapture* audio;
    { std::lock_guard lock(g_stateMutex); screen = g_screenCapture.get(); audio = g_audioCapture.get(); }
    if (!screen) return false;
    bool ok = screen->Start([](const FrameData& frame) {
        const auto arrived = std::chrono::steady_clock::now();
        static auto lastArrival = arrived;
        g_intervalUs.store(std::chrono::duration_cast<std::chrono::microseconds>(arrived - lastArrival).count());
        lastArrival = arrived;

        std::vector<EncodedPacket> packets;
        bool ready = false;
        { std::lock_guard encodeLock(g_encodeMutex);
          if (!g_encoder || !g_ringBuffer) return;
          const auto encodeStart = std::chrono::steady_clock::now();
          if (!g_encoder->EncodeFrame(frame, packets)) {
              g_encodeFailures.fetch_add(1);
              if (g_encodeFailureStreak.fetch_add(1) + 1 >= kEncoderDeadAfterFrames) g_encoderDead.store(true);
          } else g_encodeFailureStreak.store(0);
          g_encodeUs.store(std::chrono::duration_cast<std::chrono::microseconds>(
              std::chrono::steady_clock::now() - encodeStart).count());
          g_framesDelivered.fetch_add(1);
          for (const auto& packet : packets) { g_ringBuffer->Push(packet); g_packetsPushed.fetch_add(1); ready = ready || packet.isKeyframe; }
        }
        if (ready) { std::lock_guard lock(g_stateMutex); g_awaitingFirstKeyframe = false; g_previousVideo.clear(); g_previousAudio.clear(); }
    });
    if (ok && audio) audio->Start([](const AudioData& value) {
        if (!value.samples || !value.frameCount || !value.channels) return;
        OwnedAudio owned; owned.frameCount = value.frameCount; owned.channels = value.channels;
        owned.sampleRate = value.sampleRate; owned.timestampUs = value.timestamp_us;
        owned.sourceId = value.sourceId;
        owned.samples.assign(value.samples, value.samples + static_cast<size_t>(value.frameCount) * value.channels);
        std::lock_guard lock(g_stateMutex); g_audioBuffer.push_back(std::move(owned));
        const int64_t cutoff = value.timestamp_us - static_cast<int64_t>(g_bufferSeconds) * 1000000;
        while (!g_audioBuffer.empty() && g_audioBuffer.front().timestampUs < cutoff) g_audioBuffer.pop_front();
    });
    return ok;
}

bool BuildPipeline(bool initializeAudio) {
    g_pipelineError.clear();
    g_encoderDead.store(false);
    g_encodeFailureStreak.store(0);
    // Release the previous capture BEFORE building the replacement. DXGI permits
    // only one active output duplication per output per process, and the old
    // ScreenCapture holds one until it is destroyed — so DuplicateOutput on the
    // new one fails with NOT_CURRENTLY_AVAILABLE and every setQuality/setDisplay
    // call reports failure. The encoder is released first because on the
    // zero-copy path it holds textures belonging to the old D3D device.
    {
        std::scoped_lock lock(g_stateMutex, g_encodeMutex);
        g_encoder.reset();
        g_screenCapture.reset();
    }
    const auto displays = ScreenCapture::ListDisplays();
    if (g_displayId >= displays.size()) { g_pipelineError = "display not found"; return false; }
    const auto& display = displays[g_displayId];
    const uint32_t outputHeight = (std::min)(g_quality.height, display.height);
    const uint32_t outputWidth = ComputeEvenWidth(display.width, display.height, outputHeight);
    auto screen = std::make_shared<ScreenCapture>();
    if (!screen->Initialize(g_quality.fps, outputWidth, outputHeight, g_displayId)) { g_pipelineError = "DXGI capture initialization failed"; return false; }
    EncoderConfig config; config.width = outputWidth; config.height = outputHeight; config.fps = g_quality.fps;
    config.bitrate = g_quality.bitrateKbps * 1000; config.device = screen->HasGpuOutput() ? screen->GetDevice() : nullptr;
    auto encoder = CreateEncoder(config); if (!encoder) { g_pipelineError = "no Media Foundation H.264 encoder initialized"; return false; }
    screen->SetGpuOutputEnabled(encoder->IsHardwareAccelerated());
    std::unique_ptr<AudioCapture> audio;
    if (initializeAudio) { audio = std::make_unique<AudioCapture>(); audio->Initialize(); }
    else { std::lock_guard lock(g_stateMutex); audio = std::move(g_audioCapture); }
    auto ring = std::make_unique<RingBuffer>(g_bufferSeconds, g_quality.fps);
    std::scoped_lock lock(g_stateMutex, g_encodeMutex);
    // The encoder's DXGI device manager references the capture device. Destroy it
    // before replacing the ScreenCapture that owns that device.
    g_encoder.reset(); g_screenCapture.reset();
    g_screenCapture = std::move(screen); g_audioCapture = std::move(audio); g_encoder = std::move(encoder);
    g_ringBuffer = std::move(ring); g_audioBuffer.clear(); g_encodeWidth = outputWidth; g_encodeHeight = outputHeight; return true;
}

void Cleanup(void*) {
    StopCapture();
    if (g_voiceTrigger) {
        g_voiceTrigger->SetEnabled(false);
        g_voiceTrigger->SetCallback({});
        g_voiceTrigger.reset();
    }
    if (g_voiceCallback) {
        g_voiceCallback->Close();
        g_voiceCallback.reset();
    }
    std::scoped_lock lock(g_stateMutex, g_encodeMutex);
    g_encoder.reset(); g_audioCapture.reset(); g_screenCapture.reset();
    g_ringBuffer.reset(); g_audioBuffer.clear();
}

Napi::Value Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env(); StopCapture();
    if (info.Length() > 1 && info[1].IsNumber()) g_displayId = info[1].As<Napi::Number>().Uint32Value();
    g_clipsDir = info.Length() && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : (std::filesystem::temp_directory_path() / "Flash" / "Clips").string();
    bool ok = BuildPipeline(true); GpuVendor vendor = DetectGpuVendor();
    std::lock_guard lock(g_stateMutex); auto result = Napi::Object::New(env);
    result.Set("screenCapture", ok); result.Set("audioCapture", g_audioCapture != nullptr);
    result.Set("encoder", g_encoder ? g_encoder->GetName() : "none"); result.Set("hwAccel", g_encoder && g_encoder->IsHardwareAccelerated());
    result.Set("gpu", vendor == GpuVendor::Nvidia ? "nvidia" : vendor == GpuVendor::Amd ? "amd" : vendor == GpuVendor::Intel ? "intel" : "unknown");
    result.Set("width", g_encodeWidth); result.Set("height", g_encodeHeight); if (!ok) result.Set("error", g_pipelineError); return result;
}

Napi::Value StartReplayBuffer(const Napi::CallbackInfo& info) {
    // A dead encoder cannot be restarted by starting its threads again, so the
    // watchdog's stop/start only recovers if the pipeline is rebuilt first.
    if (g_encoderDead.load()) {
        StopCapture();
        if (!BuildPipeline(false)) { Napi::Error::New(info.Env(), g_pipelineError).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    }
    { std::lock_guard lock(g_stateMutex); if (!g_screenCapture || !g_encoder || !g_ringBuffer) { Napi::Error::New(info.Env(), "capture system is not initialized").ThrowAsJavaScriptException(); return info.Env().Undefined(); } if (g_screenCapture->IsCapturing()) return Napi::Boolean::New(info.Env(), true); }
    if (!StartCaptureThreads()) { Napi::Error::New(info.Env(), "failed to start DXGI capture thread").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    return Napi::Boolean::New(info.Env(), true);
}
Napi::Value StopReplayBuffer(const Napi::CallbackInfo& info) { StopCapture(); return info.Env().Undefined(); }

Napi::Value SetClipsDir(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsString()) { Napi::TypeError::New(info.Env(), "clips directory must be a non-empty string").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    std::string path = info[0].As<Napi::String>().Utf8Value();
    if (path.empty()) { Napi::TypeError::New(info.Env(), "clips directory must be a non-empty string").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    std::lock_guard lock(g_stateMutex); g_clipsDir = std::move(path); return info.Env().Undefined();
}

class SaveClipWorker final : public Napi::AsyncWorker {
public:
    SaveClipWorker(Napi::Env env, std::string path, std::string game, std::vector<EncodedPacket> video, std::vector<OwnedAudio> audio, uint32_t width, uint32_t height, uint32_t fps)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), path_(std::move(path)), game_(std::move(game)), video_(std::move(video)), audio_(std::move(audio)), width_(width), height_(height), fps_(fps) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override { try { std::vector<AudioData> views; for (auto& p : audio_) views.push_back({p.samples.data(), p.frameCount, p.channels, p.sampleRate, p.timestampUs, p.sourceId}); metadata_ = ClipWriter().Write(path_, video_, views, width_, height_, fps_, game_); } catch (const std::exception& e) { SetError(e.what()); } }
    void OnOK() override { auto value = Napi::Object::New(Env()); value.Set("path", metadata_.filePath); value.Set("duration", metadata_.durationSeconds); value.Set("game", metadata_.game); value.Set("width", metadata_.width); value.Set("height", metadata_.height); value.Set("timestamp", Napi::Number::New(Env(), static_cast<double>(metadata_.timestamp))); deferred_.Resolve(value); }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_; std::string path_, game_; std::vector<EncodedPacket> video_; std::vector<OwnedAudio> audio_; uint32_t width_, height_, fps_; ClipMetadata metadata_{};
};

Napi::Value SaveClip(const Napi::CallbackInfo& info) {
    double windowSeconds = 0.0;
    // Treat an explicit undefined/null as "not supplied". saveClip(x) where x is
    // undefined still reports Length() == 1, so requiring a number here rejects
    // the ordinary JS way of forwarding an optional argument.
    if (info.Length() && !info[0].IsUndefined() && !info[0].IsNull()) {
        if (!info[0].IsNumber()) { Napi::TypeError::New(info.Env(), "clip length must be a positive number").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
        windowSeconds = info[0].As<Napi::Number>().DoubleValue();
        if (!std::isfinite(windowSeconds) || windowSeconds <= 0.0) { Napi::TypeError::New(info.Env(), "clip length must be a positive number").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    }
    std::vector<EncodedPacket> video; std::vector<OwnedAudio> audio; std::string path, game; uint32_t width, height, fps;
    // Refused rather than served: the buffer holds only what was encoded before
    // the encoder stopped, and a clip of something that happened minutes ago is
    // worse than no clip, because it looks like it worked.
    if (g_encoderDead.load()) { Napi::Error::New(info.Env(), "the video encoder stopped accepting frames").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    { std::lock_guard lock(g_stateMutex); if (!g_ringBuffer) { Napi::Error::New(info.Env(), "capture system is not initialized").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
      if (g_awaitingFirstKeyframe && !g_previousVideo.empty()) {
          width = g_previousWidth; height = g_previousHeight; fps = g_previousFps; audio = g_previousAudio;
          if (windowSeconds > 0.0) { RingBuffer previous(g_bufferSeconds, fps); for (const auto& packet : g_previousVideo) previous.Push(packet); video = previous.Flush(windowSeconds); }
          else video = g_previousVideo;
      }
      else { video = g_ringBuffer->Flush(windowSeconds); audio.assign(g_audioBuffer.begin(), g_audioBuffer.end()); width = g_encodeWidth; height = g_encodeHeight; fps = g_quality.fps; }
      if (video.empty()) { Napi::Error::New(info.Env(), "replay buffer is empty").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
      // Audio outside the video's span has to go, and that is true of a
      // full-buffer save as much as a windowed one. It used to be done only
      // when a length was given, so a hotkey save kept audio reaching back
      // before the first video packet. Every one of those samples clamps to
      // timestamp zero on the way out, IMFSinkWriter waits for the video
      // stream to catch up to audio it has already been handed, and the save
      // never returns - measured as a hang that a 28-second save did not have
      // and a full-buffer save with audio disabled did not have either.
      {
          const int64_t startUs = video.front().timestamp_us, endUs = video.back().timestamp_us + 1000000 / fps;
          audio.erase(std::remove_if(audio.begin(), audio.end(), [=](const OwnedAudio& packet) {
              const int64_t packetEndUs = packet.timestampUs + (packet.sampleRate ? static_cast<int64_t>(packet.frameCount) * 1000000 / packet.sampleRate : 0);
              return !packet.sampleRate || packet.timestampUs < startUs || packetEndUs > endUs;
          }), audio.end());
      }
      game = g_currentGame; path = ClipWriter::GenerateClipPath(g_clipsDir, game); }
    auto* worker = new SaveClipWorker(info.Env(), std::move(path), std::move(game), std::move(video), std::move(audio), width, height, fps); auto promise = worker->Promise(); worker->Queue(); return promise;
}

class TrimClipWorker final : public Napi::AsyncWorker {
public:
    TrimClipWorker(Napi::Env env, std::string input, std::string output, int64_t startUs, int64_t endUs)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), input_(std::move(input)),
          output_(std::move(output)), startUs_(startUs), endUs_(endUs) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override { try { metadata_ = TrimClip(input_, output_, startUs_, endUs_); } catch (const std::exception& e) { SetError(e.what()); } }
    void OnOK() override { auto value = Napi::Object::New(Env()); value.Set("path", metadata_.filePath); value.Set("duration", metadata_.durationSeconds); value.Set("width", metadata_.width); value.Set("height", metadata_.height); value.Set("actualStartSeconds", metadata_.actualStartSeconds); deferred_.Resolve(value); }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_; std::string input_, output_; int64_t startUs_, endUs_; ClipMetadata metadata_{};
};

Napi::Value TrimClipAsync(const Napi::CallbackInfo& info) {
    if (info.Length() != 4 || !info[0].IsString() || !info[1].IsString() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(info.Env(), "trimClip requires input, output, startSeconds, and endSeconds").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    const std::string input = info[0].As<Napi::String>().Utf8Value();
    const std::string output = info[1].As<Napi::String>().Utf8Value();
    const double start = info[2].As<Napi::Number>().DoubleValue();
    const double end = info[3].As<Napi::Number>().DoubleValue();
    constexpr double maxSeconds = static_cast<double>((std::numeric_limits<int64_t>::max)()) / 1000000.0;
    if (input.empty() || output.empty()) { Napi::TypeError::New(info.Env(), "clip paths must not be empty").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    if (!std::isfinite(start) || !std::isfinite(end) || start < 0.0 || end <= start || end > maxSeconds) { Napi::RangeError::New(info.Env(), "trim range must have a finite non-negative start and end after start").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto* worker = new TrimClipWorker(info.Env(), input, output,
        static_cast<int64_t>(std::llround(start * 1000000.0)),
        static_cast<int64_t>(std::llround(end * 1000000.0)));
    auto promise = worker->Promise(); worker->Queue(); return promise;
}

// Everything game detection needs, in one call. It replaced a tasklist spawn
// and two PowerShell scripts that ran every three seconds; see process_list.h.
Napi::Value ListProcessesBinding(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    const ProcessSnapshot snapshot = ListProcesses();
    auto list = Napi::Array::New(env, snapshot.processes.size());
    for (size_t i = 0; i < snapshot.processes.size(); ++i) {
        const ProcessInfo& process = snapshot.processes[i];
        auto entry = Napi::Object::New(env);
        entry.Set("pid", Napi::Number::New(env, process.pid));
        entry.Set("exe", Napi::String::New(env, process.exe));
        entry.Set("path", Napi::String::New(env, process.path));
        entry.Set("windowTitle", Napi::String::New(env, process.windowTitle));
        entry.Set("workingSet", Napi::Number::New(env, static_cast<double>(process.workingSet)));
        // A FILETIME does not fit a double exactly, but the error is under two
        // microseconds and this is only ever used to order two launches.
        entry.Set("startTicks", Napi::Number::New(env, static_cast<double>(process.startTicks)));
        list.Set(i, entry);
    }
    auto result = Napi::Object::New(env);
    result.Set("foregroundPid", Napi::Number::New(env, snapshot.foregroundPid));
    result.Set("processes", list);
    return result;
}

Napi::Value GetStatus(const Napi::CallbackInfo& info) {
    std::lock_guard lock(g_stateMutex); auto result = Napi::Object::New(info.Env()); result.Set("recording", g_screenCapture && g_screenCapture->IsCapturing());
    const bool encoderDead = g_encoderDead.load();
    result.Set("captureHealthy", !encoderDead && g_screenCapture && g_screenCapture->IsHealthy());
    result.Set("captureError", encoderDead ? "the video encoder stopped accepting frames"
        : (g_screenCapture ? g_screenCapture->GetCaptureError() : g_pipelineError));
    result.Set("captureBackend", g_screenCapture ? g_screenCapture->GetCaptureBackend() : "none");
    result.Set("bufferSeconds", g_ringBuffer ? g_ringBuffer->GetDurationSeconds() : 0); result.Set("encoder", g_encoder ? g_encoder->GetName() : "none");
    result.Set("width", g_encodeWidth); result.Set("height", g_encodeHeight); result.Set("fps", g_quality.fps); result.Set("bitrateKbps", g_quality.bitrateKbps); result.Set("displayId", g_displayId);
    result.Set("audioMode", g_audioCapture ? g_audioCapture->GetMode() : "unavailable"); auto tracks = Napi::Object::New(info.Env());
    tracks.Set("game", g_audioGame); tracks.Set("mic", g_audioMic); tracks.Set("other", g_audioOther); result.Set("audioTracks", tracks);
    // Surface why a fallback happened, and each source's own state, so a missing
    // track is diagnosable instead of just silently absent.
    result.Set("audioError", g_audioCapture ? g_audioCapture->GetProcessError() : "");
    auto sources = Napi::Array::New(info.Env());
    if (g_audioCapture) {
        uint32_t i = 0;
        for (const auto& source : g_audioCapture->ListSources()) {
            auto entry = Napi::Object::New(info.Env());
            entry.Set("id", source.id); entry.Set("name", source.name); entry.Set("kind", source.kind);
            entry.Set("available", source.available); entry.Set("active", source.active);
            entry.Set("channels", source.channels); entry.Set("sampleRate", source.sampleRate);
            entry.Set("error", source.error);
            sources.Set(i++, entry);
        }
    }
    result.Set("audioSources", sources);
    result.Set("framesDelivered", static_cast<double>(g_framesDelivered.load()));
    result.Set("lastEncodeMs", g_encodeUs.load() / 1000.0);
    result.Set("lastIntervalMs", g_intervalUs.load() / 1000.0);
    result.Set("packetsPushed", static_cast<double>(g_packetsPushed.load()));
    result.Set("encodeFailures", static_cast<double>(g_encodeFailures.load()));
    return result;
}

Napi::Value SetCurrentGame(const Napi::CallbackInfo& info) { if (!info.Length() || !info[0].IsString()) { Napi::TypeError::New(info.Env(), "game name must be a string").ThrowAsJavaScriptException(); return info.Env().Undefined(); } if (info.Length() > 1 && !info[1].IsNumber()) { Napi::TypeError::New(info.Env(), "game PID must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); } AudioCapture* audio; bool game, mic, other; { std::lock_guard lock(g_stateMutex); g_currentGame = info[0].As<Napi::String>().Utf8Value(); audio = g_audioCapture.get(); game = g_audioGame; mic = g_audioMic; other = g_audioOther; } if (audio && info.Length() > 1) { audio->SetGameProcess(info[1].As<Napi::Number>().Uint32Value()); audio->SetSource("game", game, 1.0f); audio->SetSource("mic", mic, 1.0f); audio->SetSource("other", other, 1.0f); } return info.Env().Undefined(); }
Napi::Value SetAudioTracks(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsObject()) { Napi::TypeError::New(info.Env(), "audio tracks must be { game, mic, other }").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto value = info[0].As<Napi::Object>(); if (!value.Get("game").IsBoolean() || !value.Get("mic").IsBoolean() || !value.Get("other").IsBoolean()) { Napi::TypeError::New(info.Env(), "audio tracks must be { game, mic, other }").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    std::lock_guard lock(g_stateMutex); g_audioGame = value.Get("game").As<Napi::Boolean>(); g_audioMic = value.Get("mic").As<Napi::Boolean>(); g_audioOther = value.Get("other").As<Napi::Boolean>();
    if (g_audioCapture) { g_audioCapture->SetSource("game", g_audioGame, 1.0f); g_audioCapture->SetSource("mic", g_audioMic, 1.0f); g_audioCapture->SetSource("other", g_audioOther, 1.0f); } return info.Env().Undefined();
}
Napi::Value SetBufferLength(const Napi::CallbackInfo& info) { if (!info.Length() || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(), "buffer length must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); } uint32_t seconds = info[0].As<Napi::Number>().Uint32Value(); if (seconds < 1 || seconds > 600) { Napi::RangeError::New(info.Env(), "buffer length must be between 1 and 600 seconds").ThrowAsJavaScriptException(); return info.Env().Undefined(); } std::lock_guard lock(g_stateMutex); g_bufferSeconds = seconds; if (g_ringBuffer) g_ringBuffer->SetMaxDuration(seconds, g_quality.fps); return info.Env().Undefined(); }

Napi::Value SetQuality(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsObject()) { Napi::TypeError::New(info.Env(), "quality must be { height, fps, bitrateKbps }").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto value = info[0].As<Napi::Object>(); if (!value.Get("height").IsNumber() || !value.Get("fps").IsNumber() || !value.Get("bitrateKbps").IsNumber()) { Napi::TypeError::New(info.Env(), "quality must be { height, fps, bitrateKbps }").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    Quality next{value.Get("height").As<Napi::Number>().Uint32Value(), value.Get("fps").As<Napi::Number>().Uint32Value(), value.Get("bitrateKbps").As<Napi::Number>().Uint32Value()};
    // Re-applying the current quality is common (every game change does it) and
    // must not tear the pipeline down and drop frames for nothing.
    { std::lock_guard lock(g_stateMutex); if (g_ringBuffer && next.height == g_quality.height && next.fps == g_quality.fps && next.bitrateKbps == g_quality.bitrateKbps) return info.Env().Undefined(); }
    if (next.height < 240 || next.height > 4320 || next.fps < 1 || next.fps > 240 || next.bitrateKbps < 500 || next.bitrateKbps > 200000) { Napi::RangeError::New(info.Env(), "quality values are out of range").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    bool running; { std::lock_guard lock(g_stateMutex); running = g_screenCapture && g_screenCapture->IsCapturing(); } StopCapture(); { std::lock_guard lock(g_stateMutex); g_previousVideo = g_ringBuffer ? g_ringBuffer->Flush() : std::vector<EncodedPacket>{}; g_previousAudio.assign(g_audioBuffer.begin(), g_audioBuffer.end()); g_previousWidth = g_encodeWidth; g_previousHeight = g_encodeHeight; g_previousFps = g_quality.fps; g_awaitingFirstKeyframe = running && !g_previousVideo.empty(); } Quality previous = g_quality; g_quality = next;
    if (!BuildPipeline(false)) { g_quality = previous; BuildPipeline(false); if (running) StartCaptureThreads(); Napi::Error::New(info.Env(), "failed to apply quality settings").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    if (running && !StartCaptureThreads()) { Napi::Error::New(info.Env(), "quality applied but capture restart failed").ThrowAsJavaScriptException(); return info.Env().Undefined(); } return info.Env().Undefined();
}

Napi::Value ListDisplays(const Napi::CallbackInfo& info) { auto result = Napi::Array::New(info.Env()); uint32_t i = 0; for (const auto& d : ScreenCapture::ListDisplays()) { auto value = Napi::Object::New(info.Env()); value.Set("id", d.id); value.Set("name", d.name); value.Set("width", d.width); value.Set("height", d.height); value.Set("isPrimary", d.isPrimary); value.Set("refreshHz", d.refreshHz); result.Set(i++, value); } return result; }
Napi::Value SetDisplay(const Napi::CallbackInfo& info) { if (!info.Length() || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(), "display id must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); } uint32_t id = info[0].As<Napi::Number>().Uint32Value(); if (id >= ScreenCapture::ListDisplays().size()) { Napi::RangeError::New(info.Env(), "display id does not exist").ThrowAsJavaScriptException(); return info.Env().Undefined(); } bool running; { std::lock_guard lock(g_stateMutex); running = g_screenCapture && g_screenCapture->IsCapturing(); } StopCapture(); { std::lock_guard lock(g_stateMutex); g_previousVideo = g_ringBuffer ? g_ringBuffer->Flush() : std::vector<EncodedPacket>{}; g_previousAudio.assign(g_audioBuffer.begin(), g_audioBuffer.end()); g_previousWidth = g_encodeWidth; g_previousHeight = g_encodeHeight; g_previousFps = g_quality.fps; g_awaitingFirstKeyframe = running && !g_previousVideo.empty(); } uint32_t previous = g_displayId; g_displayId = id; if (!BuildPipeline(false)) { g_displayId = previous; BuildPipeline(false); if (running) StartCaptureThreads(); Napi::Error::New(info.Env(), "failed to switch display").ThrowAsJavaScriptException(); return info.Env().Undefined(); } if (running && !StartCaptureThreads()) Napi::Error::New(info.Env(), "display switched but capture restart failed").ThrowAsJavaScriptException(); return info.Env().Undefined(); }

Napi::Value SetVoiceEnabled(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsBoolean()) {
        Napi::TypeError::New(info.Env(), "voice enabled must be a boolean")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    if (g_voiceTrigger) g_voiceTrigger->SetEnabled(info[0].As<Napi::Boolean>());
    return info.Env().Undefined();
}

Napi::Value SetVoicePhrases(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsArray()) {
        Napi::TypeError::New(info.Env(), "voice phrases must be an array of strings")
            .ThrowAsJavaScriptException();
        return Napi::Boolean::New(info.Env(), false);
    }
    const auto values = info[0].As<Napi::Array>();
    std::vector<std::string> phrases;
    phrases.reserve(values.Length());
    for (uint32_t i = 0; i < values.Length(); ++i) {
        const auto value = values.Get(i);
        if (!value.IsString()) {
            Napi::TypeError::New(info.Env(), "every voice phrase must be a string")
                .ThrowAsJavaScriptException();
            return Napi::Boolean::New(info.Env(), false);
        }
        phrases.push_back(value.As<Napi::String>().Utf8Value());
    }
    const bool compiled = g_voiceTrigger && g_voiceTrigger->SetPhrases(phrases);
    return Napi::Boolean::New(info.Env(), compiled);
}

Napi::Value SetVoiceThreshold(const Napi::CallbackInfo& info) {
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(info.Env(), "voice threshold requires rawFloor and cooldownMs numbers")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    const double rawFloor = info[0].As<Napi::Number>().DoubleValue();
    const double cooldownMs = info[1].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(rawFloor) || rawFloor < 0.0 || rawFloor > 1.0 ||
        !std::isfinite(cooldownMs) || cooldownMs < 0.0 ||
        cooldownMs > static_cast<double>((std::numeric_limits<uint32_t>::max)())) {
        Napi::RangeError::New(info.Env(),
            "rawFloor must be between 0 and 1 and cooldownMs must be non-negative")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    if (g_voiceTrigger) {
        g_voiceTrigger->SetThreshold(rawFloor, static_cast<uint32_t>(cooldownMs));
    }
    return info.Env().Undefined();
}

Napi::Value GetVoiceStatus(const Napi::CallbackInfo& info) {
    const VoiceStatus status = g_voiceTrigger ? g_voiceTrigger->GetStatus()
                                               : g_voiceFallbackStatus;
    auto result = Napi::Object::New(info.Env());
    result.Set("available", status.available);
    result.Set("language", status.language);
    result.Set("error", status.error);
    return result;
}

Napi::Value OnVoiceCommand(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsFunction()) {
        Napi::TypeError::New(info.Env(), "voice command callback must be a function")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    auto replacement = std::make_shared<VoiceCallbackBridge>(
        info.Env(), info[0].As<Napi::Function>());
    if (g_voiceTrigger) {
        g_voiceTrigger->SetCallback(
            [replacement](const std::string& phrase, double rawConfidence) {
                replacement->Dispatch(phrase, rawConfidence);
            });
    }
    auto previous = std::move(g_voiceCallback);
    g_voiceCallback = std::move(replacement);
    if (previous) previous->Close();
    return info.Env().Undefined();
}
} // namespace


// Both of these walk or decode an entire file, so they belong off the UI thread
// even though neither writes anything.
class DecodeAudioWorker final : public Napi::AsyncWorker {
public:
    DecodeAudioWorker(Napi::Env env, std::string path, uint32_t rate)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
          path_(std::move(path)), rate_(rate) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override {
        try { tracks_ = DecodeClipAudio(path_, rate_); }
        catch (const std::exception& e) { SetError(e.what()); }
    }
    void OnOK() override {
        auto list = Napi::Array::New(Env(), tracks_.size());
        for (size_t i = 0; i < tracks_.size(); ++i) {
            auto entry = Napi::Object::New(Env());
            entry.Set("id", tracks_[i].id);
            // A typed array so the renderer gets the samples without boxing
            // every one into a JS number: a five minute track is 6.6 million.
            auto samples = Napi::Float32Array::New(Env(), tracks_[i].samples.size());
            if (!tracks_[i].samples.empty())
                std::memcpy(samples.Data(), tracks_[i].samples.data(),
                    tracks_[i].samples.size() * sizeof(float));
            entry.Set("samples", samples);
            list.Set(static_cast<uint32_t>(i), entry);
        }
        auto value = Napi::Object::New(Env());
        value.Set("sampleRate", rate_);
        value.Set("tracks", list);
        deferred_.Resolve(value);
    }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_;
    std::string path_;
    uint32_t rate_ = 0;
    std::vector<DecodedTrack> tracks_;
};

class ScanVideoWorker final : public Napi::AsyncWorker {
public:
    ScanVideoWorker(Napi::Env env, std::string path)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), path_(std::move(path)) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override {
        try { scan_ = ScanClipVideo(path_); }
        catch (const std::exception& e) { SetError(e.what()); }
    }
    void OnOK() override {
        auto keyframes = Napi::Array::New(Env(), scan_.keyframesUs.size());
        for (size_t i = 0; i < scan_.keyframesUs.size(); ++i)
            keyframes.Set(static_cast<uint32_t>(i),
                Napi::Number::New(Env(), scan_.keyframesUs[i] / 1000000.0));
        auto value = Napi::Object::New(Env());
        value.Set("keyframesSec", keyframes);
        value.Set("durationSeconds", scan_.lastTimeUs / 1000000.0);
        value.Set("bitrateKbps", VideoBitrate(scan_) / 1000);
        deferred_.Resolve(value);
    }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_;
    std::string path_;
    VideoScan scan_;
};

class ExportClipWorker final : public Napi::AsyncWorker {
public:
    ExportClipWorker(Napi::Env env, std::string input, std::string output, ExportOptions options)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
          input_(std::move(input)), output_(std::move(output)), options_(options) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override {
        try { result_ = ExportClip(input_, output_, options_); }
        catch (const std::exception& e) { SetError(e.what()); }
    }
    void OnOK() override {
        auto value = Napi::Object::New(Env());
        value.Set("path", result_.filePath);
        value.Set("duration", result_.durationSeconds);
        value.Set("width", result_.width);
        value.Set("height", result_.height);
        value.Set("bytes", static_cast<double>(result_.bytes));
        value.Set("bitrateKbps", result_.bitrateKbps);
        deferred_.Resolve(value);
    }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_;
    std::string input_, output_;
    ExportOptions options_;
    ExportResult result_{};
};

class SaveScreenshotWorker final : public Napi::AsyncWorker {
public:
    SaveScreenshotWorker(Napi::Env env, std::shared_ptr<ScreenCapture> capture,
                         std::string path)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
          capture_(std::move(capture)), path_(std::move(path)) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override {
        try { capture_->SaveScreenshot(path_); }
        catch (const std::exception& e) { SetError(e.what()); }
    }
    void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), path_)); }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_;
    std::shared_ptr<ScreenCapture> capture_;
    std::string path_;
};

// Preview audio is mono at 22050: enough to judge a mix and draw waveforms, and
// it keeps a five minute clip near 26MB across three tracks rather than 345MB.
constexpr uint32_t kPreviewSampleRate = 22050;

Napi::Value DecodeClipAudioBinding(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!info.Length() || !info[0].IsString()) {
        Napi::TypeError::New(env, "decodeClipAudio requires a clip path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto* worker = new DecodeAudioWorker(env, info[0].As<Napi::String>().Utf8Value(),
        kPreviewSampleRate);
    auto promise = worker->Promise();
    worker->Queue();
    return promise;
}

Napi::Value GetClipKeyframesBinding(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!info.Length() || !info[0].IsString()) {
        Napi::TypeError::New(env, "getClipKeyframes requires a clip path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto* worker = new ScanVideoWorker(env, info[0].As<Napi::String>().Utf8Value());
    auto promise = worker->Promise();
    worker->Queue();
    return promise;
}

Napi::Value ExportClipBinding(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsObject()) {
        Napi::TypeError::New(env, "expected (input, output, { maxBytes, maxHeight?, startSeconds?, endSeconds? })")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto options = info[2].As<Napi::Object>();
    if (!options.Get("maxBytes").IsNumber()) {
        Napi::TypeError::New(env, "maxBytes must be a number").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    ExportOptions parsed;
    const double maxBytes = options.Get("maxBytes").As<Napi::Number>().DoubleValue();
    if (!(maxBytes > 0)) {
        Napi::RangeError::New(env, "maxBytes must be greater than zero").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    parsed.maxBytes = static_cast<uint64_t>(maxBytes);
    if (options.Get("maxHeight").IsNumber())
        parsed.maxHeight = options.Get("maxHeight").As<Napi::Number>().Uint32Value();
    if (options.Get("startSeconds").IsNumber())
        parsed.startUs = static_cast<int64_t>(options.Get("startSeconds").As<Napi::Number>().DoubleValue() * 1000000.0);
    if (options.Get("endSeconds").IsNumber())
        parsed.endUs = static_cast<int64_t>(options.Get("endSeconds").As<Napi::Number>().DoubleValue() * 1000000.0);

    // Both default to no-ops, so callers written before the editor keep working.
    // Gains are keyed by name rather than position, matching setAudioTracks and
    // making it impossible to silence the wrong lane by miscounting.
    if (options.Get("gains").IsObject()) {
        auto gains = options.Get("gains").As<Napi::Object>();
        // Indices follow kAudioTrackOrder: game, mic, other.
        const Napi::Value byTrack[] = {gains.Get("game"), gains.Get("mic"), gains.Get("other")};
        for (size_t i = 0; i < parsed.gains.size(); ++i) {
            if (!byTrack[i].IsNumber()) continue;
            const double gain = byTrack[i].As<Napi::Number>().DoubleValue();
            if (!std::isfinite(gain) || gain < 0.0) {
                Napi::RangeError::New(env, "each gain must be a finite number of at least zero")
                    .ThrowAsJavaScriptException();
                return env.Undefined();
            }
            parsed.gains[i] = static_cast<float>(gain);
        }
    }
    if (options.Get("saturation").IsNumber()) {
        const double saturation = options.Get("saturation").As<Napi::Number>().DoubleValue();
        if (!std::isfinite(saturation) || saturation < 0.0 || saturation > 400.0) {
            Napi::RangeError::New(env, "saturation must be a percentage between 0 and 400")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        parsed.saturation = static_cast<uint32_t>(saturation);
    }

    auto* worker = new ExportClipWorker(env, info[0].As<Napi::String>().Utf8Value(),
        info[1].As<Napi::String>().Utf8Value(), parsed);
    auto promise = worker->Promise();
    worker->Queue();
    return promise;
}

Napi::Value SaveScreenshotBinding(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!info.Length() || !info[0].IsString()) {
        Napi::TypeError::New(env, "saveScreenshot requires a file path")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string path = info[0].As<Napi::String>().Utf8Value();
    if (path.empty()) {
        Napi::TypeError::New(env, "screenshot path must not be empty")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::shared_ptr<ScreenCapture> capture;
    {
        std::lock_guard lock(g_stateMutex);
        capture = g_screenCapture;
    }
    if (!capture || !capture->IsCapturing()) {
        Napi::Error::New(env, "capture is not running").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto* worker = new SaveScreenshotWorker(env, std::move(capture), std::move(path));
    auto promise = worker->Promise();
    worker->Queue();
    return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    napi_add_env_cleanup_hook(env, Cleanup, nullptr);
    try {
        g_voiceTrigger = std::make_unique<VoiceTrigger>();
        g_voiceFallbackStatus = g_voiceTrigger->GetStatus();
    } catch (const std::exception& error) {
        g_voiceFallbackStatus = {false, "",
            std::string("Voice recognition is unavailable: ") + error.what()};
    } catch (...) {
        g_voiceFallbackStatus = {false, "", "Voice recognition is unavailable."};
    }
    exports.Set("initialize", Napi::Function::New(env, Initialize)); exports.Set("startReplayBuffer", Napi::Function::New(env, StartReplayBuffer)); exports.Set("stopReplayBuffer", Napi::Function::New(env, StopReplayBuffer));
    exports.Set("saveClip", Napi::Function::New(env, SaveClip)); exports.Set("trimClip", Napi::Function::New(env, TrimClipAsync)); exports.Set("getStatus", Napi::Function::New(env, GetStatus)); exports.Set("setCurrentGame", Napi::Function::New(env, SetCurrentGame)); exports.Set("setBufferLength", Napi::Function::New(env, SetBufferLength)); exports.Set("exportClip", Napi::Function::New(env, ExportClipBinding)); exports.Set("setClipsDir", Napi::Function::New(env, SetClipsDir));
    exports.Set("setQuality", Napi::Function::New(env, SetQuality)); exports.Set("listDisplays", Napi::Function::New(env, ListDisplays)); exports.Set("setDisplay", Napi::Function::New(env, SetDisplay)); exports.Set("setAudioTracks", Napi::Function::New(env, SetAudioTracks));
    exports.Set("decodeClipAudio", Napi::Function::New(env, DecodeClipAudioBinding));
    exports.Set("getClipKeyframes", Napi::Function::New(env, GetClipKeyframesBinding));
    exports.Set("saveScreenshot", Napi::Function::New(env, SaveScreenshotBinding));
    exports.Set("setVoiceEnabled", Napi::Function::New(env, SetVoiceEnabled));
    exports.Set("setVoicePhrases", Napi::Function::New(env, SetVoicePhrases));
    exports.Set("setVoiceThreshold", Napi::Function::New(env, SetVoiceThreshold));
    exports.Set("getVoiceStatus", Napi::Function::New(env, GetVoiceStatus));
    exports.Set("onVoiceCommand", Napi::Function::New(env, OnVoiceCommand));
    exports.Set("listProcesses", Napi::Function::New(env, ListProcessesBinding));
    return exports;
}
NODE_API_MODULE(flash_capture, Init)
