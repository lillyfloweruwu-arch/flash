#include <napi.h>
#include "capture/screen_capture.h"
#include "capture/audio_capture.h"
#include "encoding/encoder.h"
#include "buffer/ring_buffer.h"
#include "buffer/clip_writer.h"
#include "quality.h"
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <vector>

using namespace flash;

namespace {
struct OwnedAudio { std::vector<float> samples; uint32_t frameCount = 0, channels = 0, sampleRate = 0; int64_t timestampUs = 0; std::string sourceId; };
struct Quality { uint32_t height = 1080, fps = 60, bitrateKbps = 20000; };

std::mutex g_stateMutex, g_encodeMutex;
std::unique_ptr<ScreenCapture> g_screenCapture;
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

void StopCapture() {
    ScreenCapture* screen; AudioCapture* audio;
    { std::lock_guard lock(g_stateMutex); screen = g_screenCapture.get(); audio = g_audioCapture.get(); }
    if (screen) screen->Stop(); if (audio) audio->Stop();
}

bool StartCaptureThreads() {
    ScreenCapture* screen; AudioCapture* audio;
    { std::lock_guard lock(g_stateMutex); screen = g_screenCapture.get(); audio = g_audioCapture.get(); }
    if (!screen) return false;
    bool ok = screen->Start([](const FrameData& frame) {
        std::vector<EncodedPacket> packets;
        bool ready = false;
        { std::lock_guard encodeLock(g_encodeMutex);
          if (!g_encoder || !g_ringBuffer) return;
          g_encoder->EncodeFrame(frame, packets);
          for (const auto& packet : packets) { g_ringBuffer->Push(packet); ready = ready || packet.isKeyframe; }
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
    const auto displays = ScreenCapture::ListDisplays();
    if (g_displayId >= displays.size()) { g_pipelineError = "display not found"; return false; }
    const auto& display = displays[g_displayId];
    const uint32_t outputHeight = (std::min)(g_quality.height, display.height);
    const uint32_t outputWidth = ComputeEvenWidth(display.width, display.height, outputHeight);
    auto screen = std::make_unique<ScreenCapture>();
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

void Cleanup(void*) { StopCapture(); std::scoped_lock lock(g_stateMutex, g_encodeMutex); g_encoder.reset(); g_audioCapture.reset(); g_screenCapture.reset(); g_ringBuffer.reset(); g_audioBuffer.clear(); }

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
    { std::lock_guard lock(g_stateMutex); if (!g_screenCapture || !g_encoder || !g_ringBuffer) { Napi::Error::New(info.Env(), "capture system is not initialized").ThrowAsJavaScriptException(); return info.Env().Undefined(); } if (g_screenCapture->IsCapturing()) return Napi::Boolean::New(info.Env(), true); }
    if (!StartCaptureThreads()) { Napi::Error::New(info.Env(), "failed to start DXGI capture thread").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    return Napi::Boolean::New(info.Env(), true);
}
Napi::Value StopReplayBuffer(const Napi::CallbackInfo& info) { StopCapture(); return info.Env().Undefined(); }

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
    std::vector<EncodedPacket> video; std::vector<OwnedAudio> audio; std::string path, game; uint32_t width, height, fps;
    { std::lock_guard lock(g_stateMutex); if (!g_ringBuffer) { Napi::Error::New(info.Env(), "capture system is not initialized").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
      if (g_awaitingFirstKeyframe && !g_previousVideo.empty()) { video = g_previousVideo; audio = g_previousAudio; width = g_previousWidth; height = g_previousHeight; fps = g_previousFps; }
      else { video = g_ringBuffer->Flush(); audio.assign(g_audioBuffer.begin(), g_audioBuffer.end()); width = g_encodeWidth; height = g_encodeHeight; fps = g_quality.fps; }
      if (video.empty()) { Napi::Error::New(info.Env(), "replay buffer is empty").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
      game = g_currentGame; path = ClipWriter::GenerateClipPath(g_clipsDir, game); }
    auto* worker = new SaveClipWorker(info.Env(), std::move(path), std::move(game), std::move(video), std::move(audio), width, height, fps); auto promise = worker->Promise(); worker->Queue(); return promise;
}

Napi::Value GetStatus(const Napi::CallbackInfo& info) {
    std::lock_guard lock(g_stateMutex); auto result = Napi::Object::New(info.Env()); result.Set("recording", g_screenCapture && g_screenCapture->IsCapturing());
    result.Set("bufferSeconds", g_ringBuffer ? g_ringBuffer->GetDurationSeconds() : 0); result.Set("encoder", g_encoder ? g_encoder->GetName() : "none");
    result.Set("width", g_encodeWidth); result.Set("height", g_encodeHeight); result.Set("fps", g_quality.fps); result.Set("bitrateKbps", g_quality.bitrateKbps); result.Set("displayId", g_displayId);
    result.Set("audioMode", g_audioCapture ? g_audioCapture->GetMode() : "unavailable"); auto tracks = Napi::Object::New(info.Env());
    tracks.Set("game", g_audioGame); tracks.Set("mic", g_audioMic); tracks.Set("other", g_audioOther); result.Set("audioTracks", tracks); return result;
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
    if (next.height < 240 || next.height > 4320 || next.fps < 1 || next.fps > 240 || next.bitrateKbps < 500 || next.bitrateKbps > 200000) { Napi::RangeError::New(info.Env(), "quality values are out of range").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    bool running; { std::lock_guard lock(g_stateMutex); running = g_screenCapture && g_screenCapture->IsCapturing(); } StopCapture(); { std::lock_guard lock(g_stateMutex); g_previousVideo = g_ringBuffer ? g_ringBuffer->Flush() : std::vector<EncodedPacket>{}; g_previousAudio.assign(g_audioBuffer.begin(), g_audioBuffer.end()); g_previousWidth = g_encodeWidth; g_previousHeight = g_encodeHeight; g_previousFps = g_quality.fps; g_awaitingFirstKeyframe = running && !g_previousVideo.empty(); } Quality previous = g_quality; g_quality = next;
    if (!BuildPipeline(false)) { g_quality = previous; BuildPipeline(false); if (running) StartCaptureThreads(); Napi::Error::New(info.Env(), "failed to apply quality settings").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    if (running && !StartCaptureThreads()) { Napi::Error::New(info.Env(), "quality applied but capture restart failed").ThrowAsJavaScriptException(); return info.Env().Undefined(); } return info.Env().Undefined();
}

Napi::Value ListDisplays(const Napi::CallbackInfo& info) { auto result = Napi::Array::New(info.Env()); uint32_t i = 0; for (const auto& d : ScreenCapture::ListDisplays()) { auto value = Napi::Object::New(info.Env()); value.Set("id", d.id); value.Set("name", d.name); value.Set("width", d.width); value.Set("height", d.height); value.Set("isPrimary", d.isPrimary); result.Set(i++, value); } return result; }
Napi::Value SetDisplay(const Napi::CallbackInfo& info) { if (!info.Length() || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(), "display id must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); } uint32_t id = info[0].As<Napi::Number>().Uint32Value(); if (id >= ScreenCapture::ListDisplays().size()) { Napi::RangeError::New(info.Env(), "display id does not exist").ThrowAsJavaScriptException(); return info.Env().Undefined(); } bool running; { std::lock_guard lock(g_stateMutex); running = g_screenCapture && g_screenCapture->IsCapturing(); } StopCapture(); { std::lock_guard lock(g_stateMutex); g_previousVideo = g_ringBuffer ? g_ringBuffer->Flush() : std::vector<EncodedPacket>{}; g_previousAudio.assign(g_audioBuffer.begin(), g_audioBuffer.end()); g_previousWidth = g_encodeWidth; g_previousHeight = g_encodeHeight; g_previousFps = g_quality.fps; g_awaitingFirstKeyframe = running && !g_previousVideo.empty(); } uint32_t previous = g_displayId; g_displayId = id; if (!BuildPipeline(false)) { g_displayId = previous; BuildPipeline(false); if (running) StartCaptureThreads(); Napi::Error::New(info.Env(), "failed to switch display").ThrowAsJavaScriptException(); return info.Env().Undefined(); } if (running && !StartCaptureThreads()) Napi::Error::New(info.Env(), "display switched but capture restart failed").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    napi_add_env_cleanup_hook(env, Cleanup, nullptr);
    exports.Set("initialize", Napi::Function::New(env, Initialize)); exports.Set("startReplayBuffer", Napi::Function::New(env, StartReplayBuffer)); exports.Set("stopReplayBuffer", Napi::Function::New(env, StopReplayBuffer));
    exports.Set("saveClip", Napi::Function::New(env, SaveClip)); exports.Set("getStatus", Napi::Function::New(env, GetStatus)); exports.Set("setCurrentGame", Napi::Function::New(env, SetCurrentGame)); exports.Set("setBufferLength", Napi::Function::New(env, SetBufferLength));
    exports.Set("setQuality", Napi::Function::New(env, SetQuality)); exports.Set("listDisplays", Napi::Function::New(env, ListDisplays)); exports.Set("setDisplay", Napi::Function::New(env, SetDisplay)); exports.Set("setAudioTracks", Napi::Function::New(env, SetAudioTracks)); return exports;
}
NODE_API_MODULE(flash_capture, Init)
