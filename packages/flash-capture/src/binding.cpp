#include <napi.h>
#include "core/platform.h"

#include "core/voice_trigger.h"
#include "core/encoder.h"
#include "core/ring_buffer.h"
#include "core/clip_writer.h"
#include "core/clip_exporter.h"
#include "core/clip_trimmer.h"
#include "core/audio_decode.h"
#include "core/smart_render.h"
#include "core/process_list.h"
#include "core/quality.h"
#include "core/audio_tracks.h"
#include <algorithm>
#include <array>
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

struct VoiceCommandEvent {
    std::string phrase;
    double rawConfidence = 0.0;
};

class VoiceCallbackBridge {
    static void CallJs(Napi::Env env, Napi::Function callback, void*, VoiceCommandEvent* value) {
        std::unique_ptr<VoiceCommandEvent> event(value);
        // Aborted queues are drained with no environment/callback. The typed
        // TSFN still delivers the payload so it can be freed without entering JS.
        if (!env || !callback) return;
        callback.Call({
            Napi::String::New(env, event->phrase),
            Napi::Number::New(env, event->rawConfidence),
        });
    }
    using Callback = Napi::TypedThreadSafeFunction<void, VoiceCommandEvent, CallJs>;

public:
    VoiceCallbackBridge(Napi::Env env, const Napi::Function& callback)
        : tsfn_(Callback::New(
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
        const napi_status status = tsfn_.NonBlockingCall(event);
        if (status != napi_ok) delete event;
    }

    void Close() noexcept {
        std::lock_guard lock(mutex_);
        if (!closed_.exchange(true)) tsfn_.Abort();
    }

private:
    Callback tsfn_;
    std::mutex mutex_;
    std::atomic<bool> closed_{false};
};

// All capture state belongs to this Node environment. No thread, COM object or
// Node-API handle is owned by a process/static destructor.
struct AddonState {
std::mutex stateMutex, encodeMutex;
std::shared_ptr<VideoSource> screenCapture;
std::unique_ptr<AudioSource> audioCapture;
std::unique_ptr<Encoder> encoder;
std::unique_ptr<RingBuffer> ringBuffer;
std::deque<OwnedAudio> audioBuffer;
std::vector<EncodedPacket> previousVideo;
std::vector<OwnedAudio> previousAudio;
std::string clipsDir, currentGame = "Unknown";
uint32_t bufferSeconds = 30, displayId = 0, encodeWidth = 1920, encodeHeight = 1080;
uint32_t previousWidth = 0, previousHeight = 0, previousFps = 0;
bool awaitingFirstKeyframe = false;
Quality quality;
// Whether each track is recorded, in kAudioTrackOrder.
std::array<bool, kAudioTrackCount> audioEnabled{true, true, true, true, true};
// Which executables go to the Discord and Music lanes. Lower case.
AudioLaneConfig audioLanes{{"discord.exe"}, {"spotify.exe"}};
std::string pipelineError;
std::unique_ptr<VoiceTrigger> voiceTrigger;
VoiceStatus voiceFallbackStatus{false, "", "Voice recognition is unavailable."};

bool shuttingDown = false;

std::shared_ptr<VoiceCallbackBridge> voiceCallback;
std::shared_ptr<VoiceCallbackBridge> portalCallback;

Napi::Value SetPortalRestoreTokenBinding(const Napi::CallbackInfo& info) {
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(info.Env(), "Expected a restore token and persistence callback").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    if (portalCallback) portalCallback->Close();
    portalCallback = std::make_shared<VoiceCallbackBridge>(info.Env(), info[1].As<Napi::Function>());
    RefreshCleanupHook(info.Env());
    std::weak_ptr<VoiceCallbackBridge> weak = portalCallback;
    SetPortalRestoreToken(info[0].As<Napi::String>().Utf8Value(), [weak](const std::string& token) {
        if (auto callback = weak.lock()) callback->Dispatch(token, 0);
    });
    return info.Env().Undefined();
}


void StopCapture() {
    VideoSource* screen; AudioSource* audio;
    { std::lock_guard lock(stateMutex); screen = screenCapture.get(); audio = audioCapture.get(); }
    if (screen) screen->Stop(); if (audio) audio->Stop();
}

// Rolling capture timings, surfaced through getStatus(). Cheap to keep, and the
// difference between "the encoder is slow" and "frames never arrive" is not
// guessable from the outside.
std::atomic<int64_t> framesDelivered{0}, encodeUs{0}, intervalUs{0}, packetsPushed{0}, encodeFailures{0};

// One failed frame is a hiccup worth counting and nothing more. An unbroken
// run of them is a dead encoder, and that used to be invisible: capture stayed
// "healthy", the ring buffer kept whatever it held from before the encoder
// died, and the next hotkey press handed back that old footage as a fresh
// clip. Two seconds at 60fps is far beyond any transient, so this cannot trip
// on a working encoder.
static constexpr int kEncoderDeadAfterFrames = 120;
std::atomic<int> encodeFailureStreak{0};
std::atomic<bool> encoderDead{false};
// Set when a hardware encoder stopped accepting frames; later rebuilds use software.
std::atomic<bool> hardwareEncoderBroken{false};

std::chrono::steady_clock::time_point lastArrival{};

bool StartCaptureThreads() {
    VideoSource* screen; AudioSource* audio;
    { std::lock_guard lock(stateMutex); screen = screenCapture.get(); audio = audioCapture.get(); }
    if (!screen) return false;
    bool ok = screen->Start([this](const FrameData& frame) {
        const auto arrived = std::chrono::steady_clock::now();
        if (lastArrival == std::chrono::steady_clock::time_point{}) lastArrival = arrived;
        intervalUs.store(std::chrono::duration_cast<std::chrono::microseconds>(arrived - lastArrival).count());
        lastArrival = arrived;

        std::vector<EncodedPacket> packets;
        bool ready = false;
        { std::lock_guard encodeLock(encodeMutex);
          if (!encoder || !ringBuffer) return;
          const auto encodeStart = std::chrono::steady_clock::now();
          if (!encoder->EncodeFrame(frame, packets)) {
              encodeFailures.fetch_add(1);
              if (encodeFailureStreak.fetch_add(1) + 1 >= kEncoderDeadAfterFrames) encoderDead.store(true);
          } else encodeFailureStreak.store(0);
          encodeUs.store(std::chrono::duration_cast<std::chrono::microseconds>(
              std::chrono::steady_clock::now() - encodeStart).count());
          framesDelivered.fetch_add(1);
          for (const auto& packet : packets) { ringBuffer->Push(packet); packetsPushed.fetch_add(1); ready = ready || packet.isKeyframe; }
        }
        if (ready) { std::lock_guard lock(stateMutex); awaitingFirstKeyframe = false; previousVideo.clear(); previousAudio.clear(); }
    });
    if (ok && audio) audio->Start([this](const AudioData& value) {
        if (!value.samples || !value.frameCount || !value.channels) return;
        OwnedAudio owned; owned.frameCount = value.frameCount; owned.channels = value.channels;
        owned.sampleRate = value.sampleRate; owned.timestampUs = value.timestamp_us;
        owned.sourceId = value.sourceId;
        owned.samples.assign(value.samples, value.samples + static_cast<size_t>(value.frameCount) * value.channels);
        std::lock_guard lock(stateMutex); audioBuffer.push_back(std::move(owned));
        const int64_t cutoff = value.timestamp_us - static_cast<int64_t>(bufferSeconds) * 1000000;
        while (!audioBuffer.empty() && audioBuffer.front().timestampUs < cutoff) audioBuffer.pop_front();
    });
    return ok;
}

bool BuildPipeline(bool initializeAudio) {
    pipelineError.clear();
    if (encoderDead.load()) {
        std::lock_guard lock(stateMutex);
        if (encoder && encoder->IsHardwareAccelerated()) hardwareEncoderBroken.store(true);
    }
    encoderDead.store(false);
    encodeFailureStreak.store(0);
    // Release the previous capture BEFORE building the replacement. DXGI permits
    // only one active output duplication per output per process, and the old
    // VideoSource holds one until it is destroyed — so DuplicateOutput on the
    // new one fails with NOT_CURRENTLY_AVAILABLE and every setQuality/setDisplay
    // call reports failure. The encoder is released first because on the
    // zero-copy path it holds textures belonging to the old D3D device.
    {
        std::scoped_lock lock(stateMutex, encodeMutex);
        encoder.reset();
        screenCapture.reset();
    }
    const auto displays = ListPlatformDisplays();
    if (displayId >= displays.size()) { pipelineError = "display not found"; return false; }
    const auto& display = displays[displayId];
    const uint32_t outputHeight = (std::min)(quality.height, display.height);
    const uint32_t outputWidth = ComputeEvenWidth(display.width, display.height, outputHeight);
    auto screen = CreateVideoSource();
    if (!screen->Initialize(quality.fps, outputWidth, outputHeight, displayId)) { pipelineError = "capture initialization failed"; return false; }
    EncoderConfig config; config.width = outputWidth; config.height = outputHeight; config.fps = quality.fps;
    config.bitrate = quality.bitrateKbps * 1000; config.device = screen->HasGpuOutput() ? screen->GetDevice() : nullptr;
    config.forceSoftware = hardwareEncoderBroken.load();
    std::unique_ptr<Encoder> nextEncoder;
    try { nextEncoder = CreateEncoder(config); }
    catch (const std::exception& error) { pipelineError = error.what(); return false; }
    if (!nextEncoder) { pipelineError = "no H.264 encoder initialized"; return false; }
    screen->SetGpuOutputEnabled(nextEncoder->IsHardwareAccelerated());
    std::unique_ptr<AudioSource> audio;
    if (initializeAudio) { audio = CreateAudioSource(); audio->Initialize(); }
    // A re-created source keeps the user's lists.
    if (initializeAudio && audio) audio->SetLanes(audioLanes);
    else { std::lock_guard lock(stateMutex); audio = std::move(audioCapture); }
    auto ring = std::make_unique<RingBuffer>(bufferSeconds, quality.fps);
    std::scoped_lock lock(stateMutex, encodeMutex);
    // The encoder's DXGI device manager references the capture device. Destroy it
    // before replacing the VideoSource that owns that device.
    encoder.reset(); screenCapture.reset();
    screenCapture = std::move(screen); audioCapture = std::move(audio); encoder = std::move(nextEncoder);
    ringBuffer = std::move(ring); audioBuffer.clear(); encodeWidth = outputWidth; encodeHeight = outputHeight; return true;
}

void Shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop producers and join their threads before releasing callbacks or the
    // encoder/device they use. Never hold the capture locks while joining.
    StopCapture();
    SetPortalRestoreToken("", {});
    if (portalCallback) { portalCallback->Close(); portalCallback.reset(); }
    if (voiceTrigger) {
        voiceTrigger->SetEnabled(false);
        voiceTrigger->SetCallback({});
        voiceTrigger.reset();
    }
    if (voiceCallback) {
        voiceCallback->Close();
        voiceCallback.reset();
    }
    std::scoped_lock lock(stateMutex, encodeMutex);
    encoder.reset(); screenCapture.reset(); audioCapture.reset();
    ringBuffer.reset();
    std::deque<OwnedAudio>().swap(audioBuffer);
    std::vector<EncodedPacket>().swap(previousVideo);
    std::vector<OwnedAudio>().swap(previousAudio);
    clipsDir.clear(); currentGame.clear(); pipelineError.clear();
    voiceFallbackStatus = {};
}

Napi::Value Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env(); StopCapture();
    if (info.Length() > 1 && info[1].IsNumber()) displayId = info[1].As<Napi::Number>().Uint32Value();
    clipsDir = info.Length() && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : (std::filesystem::temp_directory_path() / "Flash" / "Clips").string();
    bool ok = BuildPipeline(true); GpuVendor vendor = DetectGpuVendor();
    std::lock_guard lock(stateMutex); auto result = Napi::Object::New(env);
    // A source is only reported when it actually opened. The microphone is
    // always in the list, so a dead one used to read as a working audio track.
    bool audioAvailable = false;
    if (audioCapture) {
        for (const auto& source : audioCapture->ListSources())
            if (source.available) { audioAvailable = true; break; }
    }
    result.Set("screenCapture", ok); result.Set("audioCapture", audioAvailable);
    result.Set("audioError", audioCapture ? audioCapture->GetProcessError() : "");
    result.Set("encoder", encoder ? encoder->GetName() : "none"); result.Set("hwAccel", encoder && encoder->IsHardwareAccelerated());
    result.Set("gpu", vendor == GpuVendor::Nvidia ? "nvidia" : vendor == GpuVendor::Amd ? "amd" : vendor == GpuVendor::Intel ? "intel" : "unknown");
    result.Set("width", encodeWidth); result.Set("height", encodeHeight); if (!ok) result.Set("error", pipelineError); return result;
}

Napi::Value StartReplayBuffer(const Napi::CallbackInfo& info) {
    // A dead encoder cannot be restarted by starting its threads again, so the
    // watchdog's stop/start only recovers if the pipeline is rebuilt first.
    if (encoderDead.load()) {
        StopCapture();
        if (!BuildPipeline(false)) { Napi::Error::New(info.Env(), pipelineError).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    }
    { std::lock_guard lock(stateMutex); if (!screenCapture || !encoder || !ringBuffer) { Napi::Error::New(info.Env(), "capture system is not initialized").ThrowAsJavaScriptException(); return info.Env().Undefined(); } if (screenCapture->IsCapturing()) return Napi::Boolean::New(info.Env(), true); }
    if (!StartCaptureThreads()) { Napi::Error::New(info.Env(), "failed to start capture thread").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    return Napi::Boolean::New(info.Env(), true);
}
Napi::Value StopReplayBuffer(const Napi::CallbackInfo& info) { StopCapture(); return info.Env().Undefined(); }

Napi::Value SetClipsDir(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsString()) { Napi::TypeError::New(info.Env(), "clips directory must be a non-empty string").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    std::string path = info[0].As<Napi::String>().Utf8Value();
    if (path.empty()) { Napi::TypeError::New(info.Env(), "clips directory must be a non-empty string").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    std::lock_guard lock(stateMutex); clipsDir = std::move(path); return info.Env().Undefined();
}

class SaveClipWorker final : public Napi::AsyncWorker {
public:
    SaveClipWorker(Napi::Env env, std::string path, std::string game, std::vector<EncodedPacket> video, std::vector<OwnedAudio> audio, uint32_t width, uint32_t height, uint32_t fps)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), path_(std::move(path)), game_(std::move(game)), video_(std::move(video)), audio_(std::move(audio)), width_(width), height_(height), fps_(fps) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override { try { std::vector<AudioData> views; for (auto& p : audio_) views.push_back({p.samples.data(), p.frameCount, p.channels, p.sampleRate, p.timestampUs, p.sourceId}); metadata_ = CreateClipMuxer()->Write(path_, video_, views, width_, height_, fps_, game_); } catch (const std::exception& e) { SetError(e.what()); } }
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
    if (encoderDead.load()) { Napi::Error::New(info.Env(), "the video encoder stopped accepting frames").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    { std::lock_guard lock(stateMutex); if (!ringBuffer) { Napi::Error::New(info.Env(), "capture system is not initialized").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
      if (awaitingFirstKeyframe && !previousVideo.empty()) {
          width = previousWidth; height = previousHeight; fps = previousFps; audio = previousAudio;
          if (windowSeconds > 0.0) { RingBuffer previous(bufferSeconds, fps); for (const auto& packet : previousVideo) previous.Push(packet); video = previous.Flush(windowSeconds); }
          else video = previousVideo;
      }
      else { video = ringBuffer->Flush(windowSeconds); audio.assign(audioBuffer.begin(), audioBuffer.end()); width = encodeWidth; height = encodeHeight; fps = quality.fps; }
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
          const int64_t startUs = video.front().pts_us, endUs = video.back().pts_us + 1000000 / fps;
          audio.erase(std::remove_if(audio.begin(), audio.end(), [=](const OwnedAudio& packet) {
              const int64_t packetEndUs = packet.timestampUs + (packet.sampleRate ? static_cast<int64_t>(packet.frameCount) * 1000000 / packet.sampleRate : 0);
              return !packet.sampleRate || packet.timestampUs < startUs || packetEndUs > endUs;
          }), audio.end());
      }
      game = currentGame; path = CreateClipMuxer()->GenerateClipPath(clipsDir, game); }
    auto* worker = new SaveClipWorker(info.Env(), std::move(path), std::move(game), std::move(video), std::move(audio), width, height, fps); auto promise = worker->Promise(); worker->Queue(); return promise;
}

class TrimClipWorker final : public Napi::AsyncWorker {
public:
    TrimClipWorker(Napi::Env env, std::string input, std::string output, int64_t startUs, int64_t endUs)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), input_(std::move(input)),
          output_(std::move(output)), startUs_(startUs), endUs_(endUs) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override { try { metadata_ = CreateClipMuxer()->Trim(input_, output_, startUs_, endUs_); } catch (const std::exception& e) { SetError(e.what()); } }
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
    const ProcessSnapshot snapshot = CreateProcessLister()->List();
    auto list = Napi::Array::New(env, snapshot.processes.size());
    for (size_t i = 0; i < snapshot.processes.size(); ++i) {
        const ProcessInfo& process = snapshot.processes[i];
        auto entry = Napi::Object::New(env);
        entry.Set("pid", Napi::Number::New(env, process.pid));
        entry.Set("exe", Napi::String::New(env, process.exe));
        entry.Set("parentPid", process.parentPid);
        entry.Set("cmdline", process.cmdline); entry.Set("steamAppId", process.steamAppId);
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
    std::lock_guard lock(stateMutex); auto result = Napi::Object::New(info.Env()); result.Set("recording", screenCapture && screenCapture->IsCapturing());
    const bool isEncoderDead = encoderDead.load();
    result.Set("captureHealthy", !isEncoderDead && screenCapture && screenCapture->IsHealthy());
    result.Set("capturePending", screenCapture && screenCapture->IsPending());
    result.Set("captureError", isEncoderDead ? "the video encoder stopped accepting frames"
        : (screenCapture ? screenCapture->GetCaptureError() : pipelineError));
    result.Set("captureBackend", screenCapture ? screenCapture->GetCaptureBackend() : "none");
    result.Set("bufferSeconds", ringBuffer ? ringBuffer->GetDurationSeconds() : 0); result.Set("encoder", encoder ? encoder->GetName() : "none");
    result.Set("width", encodeWidth); result.Set("height", encodeHeight); result.Set("fps", quality.fps); result.Set("bitrateKbps", quality.bitrateKbps); result.Set("displayId", displayId);
    result.Set("audioMode", audioCapture ? audioCapture->GetMode() : "unavailable"); auto tracks = Napi::Object::New(info.Env());
    for (size_t i = 0; i < kAudioTrackCount; ++i) tracks.Set(std::string(kAudioTrackOrder[i]), Napi::Boolean::New(info.Env(), audioEnabled[i]));
    result.Set("audioTracks", tracks);
    // Surface why a fallback happened, and each source's own state, so a missing
    // track is diagnosable instead of just silently absent.
    result.Set("audioError", audioCapture ? audioCapture->GetProcessError() : "");
    auto sources = Napi::Array::New(info.Env());
    if (audioCapture) {
        uint32_t i = 0;
        for (const auto& source : audioCapture->ListSources()) {
            auto entry = Napi::Object::New(info.Env());
            entry.Set("id", source.id); entry.Set("name", source.name); entry.Set("kind", source.kind);
            entry.Set("available", source.available); entry.Set("active", source.active);
            entry.Set("channels", source.channels); entry.Set("sampleRate", source.sampleRate);
            entry.Set("error", source.error);
            sources.Set(i++, entry);
        }
    }
    result.Set("audioSources", sources);
    result.Set("framesDelivered", static_cast<double>(framesDelivered.load()));
    result.Set("lastEncodeMs", encodeUs.load() / 1000.0);
    result.Set("lastIntervalMs", intervalUs.load() / 1000.0);
    result.Set("packetsPushed", static_cast<double>(packetsPushed.load()));
    result.Set("encodeFailures", static_cast<double>(encodeFailures.load()));
    return result;
}

Napi::Value SetCurrentGame(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsString()) { Napi::TypeError::New(info.Env(), "game name must be a string").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    if (info.Length() > 1 && !info[1].IsNumber()) { Napi::TypeError::New(info.Env(), "game PID must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    const auto name = info[0].As<Napi::String>().Utf8Value();
    const uint32_t processId = name.empty() || info.Length() < 2 ? 0 : info[1].As<Napi::Number>().Uint32Value();
    AudioSource* audio; std::array<bool, kAudioTrackCount> enabled{};
    { std::lock_guard lock(stateMutex); currentGame = name.empty() ? "Unknown" : name; audio = audioCapture.get(); enabled = audioEnabled; }
    // PID zero rebuilds the startup loopback sources, so an exited game's audio
    // target cannot linger until another game happens to launch.
    if (audio && (name.empty() || info.Length() > 1)) {
        audio->SetGameProcess(processId);
        for (size_t i = 0; i < kAudioTrackCount; ++i) audio->SetSource(std::string(kAudioTrackOrder[i]), enabled[i], 1.0f);
    }
    return info.Env().Undefined();
}
Napi::Value SetAudioTracks(const Napi::CallbackInfo& info) {
    const char* shape = "audio tracks must be { game, mic, other, discord?, music? } booleans";
    if (!info.Length() || !info[0].IsObject()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto value = info[0].As<Napi::Object>();
    std::array<bool, kAudioTrackCount> next{};
    for (size_t i = 0; i < kAudioTrackCount; ++i) {
        const auto field = value.Get(std::string(kAudioTrackOrder[i]));
        // The two newer lanes may be left out by an older caller; they then
        // follow "other", which is where their sound used to be recorded.
        if (field.IsUndefined() && i >= 3) { next[i] = next[2]; continue; }
        if (!field.IsBoolean()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
        next[i] = field.As<Napi::Boolean>();
    }
    AudioSource* audio;
    { std::lock_guard lock(stateMutex); audioEnabled = next; audio = audioCapture.get(); }
    // Not under stateMutex. Switching a source off joins its capture thread,
    // and that thread takes stateMutex to hand over every packet: holding it
    // here left the two waiting for each other, and the switch hung the app.
    if (audio) for (size_t i = 0; i < kAudioTrackCount; ++i) audio->SetSource(std::string(kAudioTrackOrder[i]), next[i], 1.0f);
    return info.Env().Undefined();
}
Napi::Value SetAudioLanes(const Napi::CallbackInfo& info) {
    const char* shape = "audio lanes must be { discord: string[], music: string[] }";
    if (!info.Length() || !info[0].IsObject()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto value = info[0].As<Napi::Object>();
    AudioLaneConfig next;
    for (auto [name, list] : {std::pair<const char*, std::vector<std::string>*>{"discord", &next.discord}, {"music", &next.music}}) {
        if (!value.Get(name).IsArray()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
        auto array = value.Get(name).As<Napi::Array>();
        for (uint32_t i = 0; i < array.Length() && i < 64; ++i) {
            const Napi::Value entry = array.Get(i);
            if (!entry.IsString()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
            list->push_back(LowerAscii(entry.As<Napi::String>().Utf8Value()));
        }
    }
    std::lock_guard lock(stateMutex); audioLanes = next;
    if (audioCapture) audioCapture->SetLanes(audioLanes);
    return info.Env().Undefined();
}
Napi::Value ListAudioApps(const Napi::CallbackInfo& info) {
    std::lock_guard lock(stateMutex); auto result = Napi::Array::New(info.Env());
    if (!audioCapture) return result;
    uint32_t i = 0;
    for (const auto& app : audioCapture->ListApps()) {
        auto entry = Napi::Object::New(info.Env());
        entry.Set("exe", app.exe); entry.Set("name", app.name); entry.Set("lane", app.lane);
        entry.Set("pid", app.pid); entry.Set("capturing", app.capturing);
        result.Set(i++, entry);
    }
    return result;
}
Napi::Value ListCaptureDevices(const Napi::CallbackInfo& info) {
    AudioSource* audio;
    { std::lock_guard lock(stateMutex); audio = audioCapture.get(); }
    auto result = Napi::Array::New(info.Env());
    if (!audio) return result;
    uint32_t i = 0;
    for (const auto& device : audio->ListCaptureDevices()) {
        auto entry = Napi::Object::New(info.Env());
        entry.Set("id", device.id); entry.Set("name", device.name); entry.Set("isDefault", device.isDefault);
        result.Set(i++, entry);
    }
    return result;
}
Napi::Value SetCaptureDevice(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsString()) { Napi::TypeError::New(info.Env(), "capture device id must be a string").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    const auto id = info[0].As<Napi::String>().Utf8Value();
    AudioSource* audio; std::array<bool, kAudioTrackCount> enabled{};
    { std::lock_guard lock(stateMutex); audio = audioCapture.get(); enabled = audioEnabled; }
    // Not under stateMutex: rebuilding the sources joins the capture threads,
    // which take it to hand over packets (see SetAudioTracks).
    if (!audio) return info.Env().Undefined();
    audio->SetCaptureDevice(id);
    for (size_t i = 0; i < kAudioTrackCount; ++i) audio->SetSource(std::string(kAudioTrackOrder[i]), enabled[i], 1.0f);
    return info.Env().Undefined();
}
Napi::Value SetBufferLength(const Napi::CallbackInfo& info) { if (!info.Length() || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(), "buffer length must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); } uint32_t seconds = info[0].As<Napi::Number>().Uint32Value(); if (seconds < 1 || seconds > 600) { Napi::RangeError::New(info.Env(), "buffer length must be between 1 and 600 seconds").ThrowAsJavaScriptException(); return info.Env().Undefined(); } std::lock_guard lock(stateMutex); bufferSeconds = seconds; if (ringBuffer) ringBuffer->SetMaxDuration(seconds, quality.fps); return info.Env().Undefined(); }

Napi::Value SetQuality(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsObject()) { Napi::TypeError::New(info.Env(), "quality must be { height, fps, bitrateKbps }").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto value = info[0].As<Napi::Object>(); if (!value.Get("height").IsNumber() || !value.Get("fps").IsNumber() || !value.Get("bitrateKbps").IsNumber()) { Napi::TypeError::New(info.Env(), "quality must be { height, fps, bitrateKbps }").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    Quality next{value.Get("height").As<Napi::Number>().Uint32Value(), value.Get("fps").As<Napi::Number>().Uint32Value(), value.Get("bitrateKbps").As<Napi::Number>().Uint32Value()};
    // Re-applying the current quality is common (every game change does it) and
    // must not tear the pipeline down and drop frames for nothing.
    { std::lock_guard lock(stateMutex); if (ringBuffer && next.height == quality.height && next.fps == quality.fps && next.bitrateKbps == quality.bitrateKbps) return info.Env().Undefined(); }
    if (next.height < 240 || next.height > 4320 || next.fps < 1 || next.fps > 240 || next.bitrateKbps < 500 || next.bitrateKbps > 200000) { Napi::RangeError::New(info.Env(), "quality values are out of range").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    bool running; { std::lock_guard lock(stateMutex); running = screenCapture && screenCapture->IsCapturing(); } StopCapture(); { std::lock_guard lock(stateMutex); previousVideo = ringBuffer ? ringBuffer->Flush() : std::vector<EncodedPacket>{}; previousAudio.assign(audioBuffer.begin(), audioBuffer.end()); previousWidth = encodeWidth; previousHeight = encodeHeight; previousFps = quality.fps; awaitingFirstKeyframe = running && !previousVideo.empty(); } Quality previous = quality; quality = next;
    if (!BuildPipeline(false)) { quality = previous; BuildPipeline(false); if (running) StartCaptureThreads(); Napi::Error::New(info.Env(), "failed to apply quality settings").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    if (running && !StartCaptureThreads()) { Napi::Error::New(info.Env(), "quality applied but capture restart failed").ThrowAsJavaScriptException(); return info.Env().Undefined(); } return info.Env().Undefined();
}

Napi::Value ListDisplays(const Napi::CallbackInfo& info) { auto result = Napi::Array::New(info.Env()); uint32_t i = 0; for (const auto& d : ListPlatformDisplays()) { auto value = Napi::Object::New(info.Env()); value.Set("id", d.id); value.Set("name", d.name); value.Set("width", d.width); value.Set("height", d.height); value.Set("isPrimary", d.isPrimary); value.Set("refreshHz", d.refreshHz); value.Set("x", d.x); value.Set("y", d.y); result.Set(i++, value); } return result; }
Napi::Value SetDisplay(const Napi::CallbackInfo& info) { if (!info.Length() || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(), "display id must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); } uint32_t id = info[0].As<Napi::Number>().Uint32Value(); if (id >= ListPlatformDisplays().size()) { Napi::RangeError::New(info.Env(), "display id does not exist").ThrowAsJavaScriptException(); return info.Env().Undefined(); } bool running; { std::lock_guard lock(stateMutex); running = screenCapture && screenCapture->IsCapturing(); } StopCapture(); { std::lock_guard lock(stateMutex); previousVideo = ringBuffer ? ringBuffer->Flush() : std::vector<EncodedPacket>{}; previousAudio.assign(audioBuffer.begin(), audioBuffer.end()); previousWidth = encodeWidth; previousHeight = encodeHeight; previousFps = quality.fps; awaitingFirstKeyframe = running && !previousVideo.empty(); } uint32_t previous = displayId; displayId = id; if (!BuildPipeline(false)) { displayId = previous; BuildPipeline(false); if (running) StartCaptureThreads(); Napi::Error::New(info.Env(), "failed to switch display").ThrowAsJavaScriptException(); return info.Env().Undefined(); } if (running && !StartCaptureThreads()) Napi::Error::New(info.Env(), "display switched but capture restart failed").ThrowAsJavaScriptException(); return info.Env().Undefined(); }

Napi::Value SetVoiceEnabled(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsBoolean()) {
        Napi::TypeError::New(info.Env(), "voice enabled must be a boolean")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    if (voiceTrigger) voiceTrigger->SetEnabled(info[0].As<Napi::Boolean>());
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
    const bool compiled = voiceTrigger && voiceTrigger->SetPhrases(phrases);
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
    if (voiceTrigger) {
        voiceTrigger->SetThreshold(rawFloor, static_cast<uint32_t>(cooldownMs));
    }
    return info.Env().Undefined();
}

Napi::Value GetVoiceStatus(const Napi::CallbackInfo& info) {
    const VoiceStatus status = voiceTrigger ? voiceTrigger->GetStatus()
                                               : voiceFallbackStatus;
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
    RefreshCleanupHook(info.Env());
    if (voiceTrigger) {
        voiceTrigger->SetCallback(
            [replacement](const std::string& phrase, double rawConfidence) {
                replacement->Dispatch(phrase, rawConfidence);
            });
    }
    auto previous = std::move(voiceCallback);
    voiceCallback = std::move(replacement);
    if (previous) previous->Close();
    return info.Env().Undefined();
}
// Both of these walk or decode an entire file, so they belong off the UI thread
// even though neither writes anything.
class DecodeAudioWorker final : public Napi::AsyncWorker {
public:
    DecodeAudioWorker(Napi::Env env, std::string path, uint32_t rate)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
          path_(std::move(path)), rate_(rate) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override {
        try { tracks_ = CreateClipMuxer()->DecodeAudio(path_, rate_); }
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
        try { scan_ = CreateClipMuxer()->ScanVideo(path_); }
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
        try { result_ = CreateClipMuxer()->Export(input_, output_, options_); }
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
        value.Set("codec", result_.codec);
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
    SaveScreenshotWorker(Napi::Env env, std::shared_ptr<VideoSource> capture,
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
    std::shared_ptr<VideoSource> capture_;
    std::string path_;
};

// Preview audio is mono at the clip's own 48000 Hz. The player and editor play
// this decode, so it is what the user hears. It used to be 22050 Hz with a
// plain linear resample and no low-pass, which folds everything above 11 kHz
// back into the audible band as harsh crackle. Clips are 48 kHz, so this takes
// the no-resample path and stays sample-accurate with the video.
static constexpr uint32_t kPreviewSampleRate = 48000;

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
        Napi::TypeError::New(env, "expected (input, output, { maxBytes, maxHeight?, startSeconds?, endSeconds?, codec?, maxFps? })")
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
        for (size_t i = 0; i < parsed.gains.size(); ++i) {
            const Napi::Value named = gains.Get(std::string(kAudioTrackOrder[i]));
            if (!named.IsNumber()) continue;
            const double gain = named.As<Napi::Number>().DoubleValue();
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

    if (!options.Get("codec").IsUndefined()) {
        const std::string codec = options.Get("codec").IsString() ? options.Get("codec").As<Napi::String>().Utf8Value() : "";
        if (codec == "auto") parsed.codec = ExportCodecChoice::Auto;
        else if (codec == "h264") parsed.codec = ExportCodecChoice::H264;
        else {
            Napi::TypeError::New(env, "codec must be 'auto' or 'h264'").ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }
    if (!options.Get("maxFps").IsUndefined()) {
        const double maxFps = options.Get("maxFps").IsNumber() ? options.Get("maxFps").As<Napi::Number>().DoubleValue() : -1.0;
        if (!std::isfinite(maxFps) || maxFps < 0.0 || maxFps > 1000.0) {
            Napi::RangeError::New(env, "maxFps must be a number between 0 and 1000").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        parsed.maxFps = static_cast<uint32_t>(maxFps);
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
    std::shared_ptr<VideoSource> capture;
    {
        std::lock_guard lock(stateMutex);
        capture = screenCapture;
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
    // process.exit() does not run env cleanup hooks in Node. Register a native
    // exit listener as well; both routes use the same idempotent shutdown.
    // Keep the state shell alive until env cleanup so later exit listeners
    // cannot call exported functions through a dangling pointer.
    auto process = env.Global().Get("process").As<Napi::Object>();
    process.Get("once").As<Napi::Function>().Call(process, {
        Napi::String::New(env, "exit"),
        Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
            static_cast<AddonState*>(info.Data())->Shutdown();
        }, "flashCaptureShutdown", this),
    });
    try {
        voiceTrigger = std::make_unique<VoiceTrigger>();
        voiceFallbackStatus = voiceTrigger->GetStatus();
    } catch (const std::exception& error) {
        voiceFallbackStatus = {false, "",
            std::string("Voice recognition is unavailable: ") + error.what()};
    } catch (...) {
        voiceFallbackStatus = {false, "", "Voice recognition is unavailable."};
    }
    exports.Set("setPortalRestoreToken", Napi::Function::New(env, Invoke<&AddonState::SetPortalRestoreTokenBinding>, "SetPortalRestoreTokenBinding", this));
    auto capabilities = Napi::Object::New(env);
#ifdef _WIN32
    capabilities.Set("smartRender", true);
#else
    capabilities.Set("smartRender", false);
    capabilities.Set("smartRenderError", "Smart render is unsupported on Linux; trim uses keyframe stream copy.");
#endif
    capabilities.Set("perAppAudio", PlatformSupportsPerAppAudio());
    exports.Set("capabilities", capabilities);
    exports.Set("initialize", Napi::Function::New(env, Invoke<&AddonState::Initialize>, "Initialize", this)); exports.Set("startReplayBuffer", Napi::Function::New(env, Invoke<&AddonState::StartReplayBuffer>, "StartReplayBuffer", this)); exports.Set("stopReplayBuffer", Napi::Function::New(env, Invoke<&AddonState::StopReplayBuffer>, "StopReplayBuffer", this));
    exports.Set("saveClip", Napi::Function::New(env, Invoke<&AddonState::SaveClip>, "SaveClip", this)); exports.Set("trimClip", Napi::Function::New(env, Invoke<&AddonState::TrimClipAsync>, "TrimClipAsync", this)); exports.Set("getStatus", Napi::Function::New(env, Invoke<&AddonState::GetStatus>, "GetStatus", this)); exports.Set("setCurrentGame", Napi::Function::New(env, Invoke<&AddonState::SetCurrentGame>, "SetCurrentGame", this)); exports.Set("setBufferLength", Napi::Function::New(env, Invoke<&AddonState::SetBufferLength>, "SetBufferLength", this)); exports.Set("exportClip", Napi::Function::New(env, Invoke<&AddonState::ExportClipBinding>, "ExportClipBinding", this)); exports.Set("setClipsDir", Napi::Function::New(env, Invoke<&AddonState::SetClipsDir>, "SetClipsDir", this));
    exports.Set("setQuality", Napi::Function::New(env, Invoke<&AddonState::SetQuality>, "SetQuality", this)); exports.Set("listDisplays", Napi::Function::New(env, Invoke<&AddonState::ListDisplays>, "ListDisplays", this)); exports.Set("setDisplay", Napi::Function::New(env, Invoke<&AddonState::SetDisplay>, "SetDisplay", this)); exports.Set("setAudioTracks", Napi::Function::New(env, Invoke<&AddonState::SetAudioTracks>, "SetAudioTracks", this));
    exports.Set("setAudioLanes", Napi::Function::New(env, Invoke<&AddonState::SetAudioLanes>, "SetAudioLanes", this));
    exports.Set("listCaptureDevices", Napi::Function::New(env, Invoke<&AddonState::ListCaptureDevices>, "ListCaptureDevices", this));
    exports.Set("setCaptureDevice", Napi::Function::New(env, Invoke<&AddonState::SetCaptureDevice>, "SetCaptureDevice", this));
    exports.Set("listAudioApps",Napi::Function::New(env, Invoke<&AddonState::ListAudioApps>, "ListAudioApps", this));
    exports.Set("decodeClipAudio", Napi::Function::New(env, Invoke<&AddonState::DecodeClipAudioBinding>, "DecodeClipAudioBinding", this));
    exports.Set("getClipKeyframes", Napi::Function::New(env, Invoke<&AddonState::GetClipKeyframesBinding>, "GetClipKeyframesBinding", this));
    exports.Set("saveScreenshot", Napi::Function::New(env, Invoke<&AddonState::SaveScreenshotBinding>, "SaveScreenshotBinding", this));
    exports.Set("setVoiceEnabled", Napi::Function::New(env, Invoke<&AddonState::SetVoiceEnabled>, "SetVoiceEnabled", this));
    exports.Set("setVoicePhrases", Napi::Function::New(env, Invoke<&AddonState::SetVoicePhrases>, "SetVoicePhrases", this));
    exports.Set("setVoiceThreshold", Napi::Function::New(env, Invoke<&AddonState::SetVoiceThreshold>, "SetVoiceThreshold", this));
    exports.Set("getVoiceStatus", Napi::Function::New(env, Invoke<&AddonState::GetVoiceStatus>, "GetVoiceStatus", this));
    exports.Set("onVoiceCommand", Napi::Function::New(env, Invoke<&AddonState::OnVoiceCommand>, "OnVoiceCommand", this));
    exports.Set("listProcesses", Napi::Function::New(env, Invoke<&AddonState::ListProcessesBinding>, "ListProcessesBinding", this));
    return exports;
}

static void Cleanup(void* data) {
    std::unique_ptr<AddonState> state(static_cast<AddonState*>(data));
    state->Shutdown();
}

// TSFNs install their own cleanup hooks. Hooks run in reverse registration
// order, so keep ours ahead of them: stop producers and Abort while the TSFN
// is still valid, including Worker termination where no JS exit event runs.
void RefreshCleanupHook(Napi::Env env) {
    napi_remove_env_cleanup_hook(env, Cleanup, this);
    napi_add_env_cleanup_hook(env, Cleanup, this);
}

template <Napi::Value (AddonState::*Method)(const Napi::CallbackInfo&)>
static Napi::Value Invoke(const Napi::CallbackInfo& info) {
    auto* state = static_cast<AddonState*>(info.Data());
    if (state->shuttingDown) {
        Napi::Error::New(info.Env(), "capture environment is shutting down")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    return (state->*Method)(info);
}
};
} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    auto state = std::make_unique<AddonState>();
    const auto status = napi_add_env_cleanup_hook(env, AddonState::Cleanup, state.get());
    if (status != napi_ok) throw Napi::Error::New(env, "could not register capture cleanup");
    // Once registered, the hook owns the state even if initialization throws.
    auto* owned = state.release();
    return owned->Init(env, exports);
}
NODE_API_MODULE(flash_capture, Init)
