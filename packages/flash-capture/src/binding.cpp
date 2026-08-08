#include <napi.h>
#include "capture/screen_capture.h"
#include "capture/audio_capture.h"
#include "encoding/encoder.h"
#include "buffer/ring_buffer.h"
#include "buffer/clip_writer.h"
#include <algorithm>
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

using namespace flash;

namespace {
struct OwnedAudio {
    std::vector<float> samples;
    uint32_t frameCount = 0, channels = 0, sampleRate = 0;
    int64_t timestampUs = 0;
};

std::mutex g_stateMutex;
std::unique_ptr<ScreenCapture> g_screenCapture;
std::unique_ptr<AudioCapture> g_audioCapture;
std::unique_ptr<Encoder> g_encoder;
std::unique_ptr<RingBuffer> g_ringBuffer;
std::deque<OwnedAudio> g_audioBuffer;
std::string g_clipsDir;
std::string g_currentGame = "Unknown";
uint32_t g_bufferSeconds = 30;
uint32_t g_fps = 60;

void StopCapture() {
    ScreenCapture* screen = nullptr;
    AudioCapture* audio = nullptr;
    { std::lock_guard lock(g_stateMutex); screen = g_screenCapture.get(); audio = g_audioCapture.get(); }
    if (screen) screen->Stop();
    if (audio) audio->Stop();
}

void Cleanup(void*) {
    StopCapture();
    std::lock_guard lock(g_stateMutex);
    g_encoder.reset(); g_audioCapture.reset(); g_screenCapture.reset(); g_ringBuffer.reset(); g_audioBuffer.clear();
}

Napi::Value Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    try {
        StopCapture();
        std::string clipsDir = info.Length() && info[0].IsString()
            ? info[0].As<Napi::String>().Utf8Value()
            : (std::filesystem::temp_directory_path() / "Flash" / "Clips").string();
        auto screen = std::make_unique<ScreenCapture>();
        bool screenOk = screen->Initialize(g_fps);
        auto audio = std::make_unique<AudioCapture>();
        bool audioOk = audio->Initialize();
        EncoderConfig config;
        if (screenOk) { config.width = screen->GetWidth(); config.height = screen->GetHeight(); }
        config.fps = g_fps;
        auto encoder = CreateEncoder(config);
        auto ring = std::make_unique<RingBuffer>(g_bufferSeconds, g_fps);
        GpuVendor vendor = DetectGpuVendor();
        {
            std::lock_guard lock(g_stateMutex);
            g_clipsDir = std::move(clipsDir); g_screenCapture = std::move(screen); g_audioCapture = std::move(audio);
            g_encoder = std::move(encoder); g_ringBuffer = std::move(ring); g_audioBuffer.clear();
        }
        auto result = Napi::Object::New(env);
        result.Set("screenCapture", screenOk); result.Set("audioCapture", audioOk);
        result.Set("encoder", g_encoder ? g_encoder->GetName() : "none");
        result.Set("hwAccel", g_encoder && g_encoder->IsHardwareAccelerated());
        const char* vendorName = vendor == GpuVendor::Nvidia ? "nvidia" : vendor == GpuVendor::Amd ? "amd" : vendor == GpuVendor::Intel ? "intel" : "unknown";
        result.Set("gpu", vendorName);
        result.Set("width", g_screenCapture ? g_screenCapture->GetWidth() : 0);
        result.Set("height", g_screenCapture ? g_screenCapture->GetHeight() : 0);
        if (!screenOk || !g_encoder) result.Set("error", !screenOk ? "DXGI screen capture initialization failed" : "No H.264 encoder is available");
        return result;
    } catch (const std::exception& e) { Napi::Error::New(env, e.what()).ThrowAsJavaScriptException(); return env.Undefined(); }
}

Napi::Value StartReplayBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard lock(g_stateMutex);
    if (!g_screenCapture || !g_encoder || !g_ringBuffer) {
        Napi::Error::New(env, "capture system is not initialized").ThrowAsJavaScriptException(); return env.Undefined();
    }
    if (g_screenCapture->IsCapturing()) return Napi::Boolean::New(env, true);
    bool ok = g_screenCapture->Start([](const FrameData& frame) {
        std::lock_guard callbackLock(g_stateMutex);
        if (!g_encoder || !g_ringBuffer) return;
        EncodedPacket packet;
        if (g_encoder->EncodeFrame(frame, packet)) g_ringBuffer->Push(packet);
    });
    if (ok && g_audioCapture) g_audioCapture->Start([](const AudioData& audio) {
        if (!audio.samples || !audio.frameCount || !audio.channels) return;
        OwnedAudio owned;
        owned.frameCount = audio.frameCount; owned.channels = audio.channels; owned.sampleRate = audio.sampleRate; owned.timestampUs = audio.timestamp_us;
        owned.samples.assign(audio.samples, audio.samples + static_cast<size_t>(audio.frameCount) * audio.channels);
        std::lock_guard callbackLock(g_stateMutex);
        g_audioBuffer.push_back(std::move(owned));
        const int64_t cutoff = audio.timestamp_us - static_cast<int64_t>(g_bufferSeconds) * 1000000;
        while (!g_audioBuffer.empty() && g_audioBuffer.front().timestampUs < cutoff) g_audioBuffer.pop_front();
    });
    if (!ok) { Napi::Error::New(env, "failed to start DXGI capture thread").ThrowAsJavaScriptException(); return env.Undefined(); }
    return Napi::Boolean::New(env, true);
}

Napi::Value StopReplayBuffer(const Napi::CallbackInfo& info) { StopCapture(); return info.Env().Undefined(); }

class SaveClipWorker final : public Napi::AsyncWorker {
public:
    SaveClipWorker(Napi::Env env, std::string path, std::string game, std::vector<EncodedPacket> video,
        std::vector<OwnedAudio> audio, uint32_t width, uint32_t height, uint32_t fps)
        : AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), path_(std::move(path)), game_(std::move(game)),
          video_(std::move(video)), ownedAudio_(std::move(audio)), width_(width), height_(height), fps_(fps) {}
    Napi::Promise Promise() const { return deferred_.Promise(); }
    void Execute() override {
        try {
            std::vector<AudioData> audio;
            audio.reserve(ownedAudio_.size());
            for (auto& p : ownedAudio_) audio.push_back({p.samples.data(), p.frameCount, p.channels, p.sampleRate, p.timestampUs});
            metadata_ = ClipWriter().Write(path_, video_, audio, width_, height_, fps_, game_);
        } catch (const std::exception& e) { SetError(e.what()); }
    }
    void OnOK() override {
        auto result = Napi::Object::New(Env());
        result.Set("path", metadata_.filePath); result.Set("duration", metadata_.durationSeconds); result.Set("game", metadata_.game);
        result.Set("width", metadata_.width); result.Set("height", metadata_.height); result.Set("timestamp", Napi::Number::New(Env(), static_cast<double>(metadata_.timestamp)));
        deferred_.Resolve(result);
    }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
private:
    Napi::Promise::Deferred deferred_;
    std::string path_, game_; std::vector<EncodedPacket> video_; std::vector<OwnedAudio> ownedAudio_;
    uint32_t width_, height_, fps_; ClipMetadata metadata_{};
};

Napi::Value SaveClip(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::vector<EncodedPacket> video; std::vector<OwnedAudio> audio;
    std::string path, game; uint32_t width, height;
    {
        std::lock_guard lock(g_stateMutex);
        if (!g_ringBuffer || !g_screenCapture) { Napi::Error::New(env, "capture system is not initialized").ThrowAsJavaScriptException(); return env.Undefined(); }
        video = g_ringBuffer->Flush();
        if (video.empty()) { Napi::Error::New(env, "replay buffer is empty").ThrowAsJavaScriptException(); return env.Undefined(); }
        audio.assign(g_audioBuffer.begin(), g_audioBuffer.end()); g_audioBuffer.clear();
        game = g_currentGame; path = ClipWriter::GenerateClipPath(g_clipsDir, game);
        width = g_screenCapture->GetWidth(); height = g_screenCapture->GetHeight();
    }
    auto* worker = new SaveClipWorker(env, std::move(path), std::move(game), std::move(video), std::move(audio), width, height, g_fps);
    auto promise = worker->Promise(); worker->Queue(); return promise;
}

Napi::Value GetStatus(const Napi::CallbackInfo& info) {
    std::lock_guard lock(g_stateMutex); auto result = Napi::Object::New(info.Env());
    result.Set("recording", g_screenCapture && g_screenCapture->IsCapturing());
    result.Set("bufferSeconds", g_ringBuffer ? g_ringBuffer->GetDurationSeconds() : 0);
    result.Set("encoder", g_encoder ? g_encoder->GetName() : "none"); return result;
}

Napi::Value SetCurrentGame(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsString()) { Napi::TypeError::New(info.Env(), "game name must be a string").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    std::lock_guard lock(g_stateMutex); g_currentGame = info[0].As<Napi::String>().Utf8Value(); return info.Env().Undefined();
}

Napi::Value SetBufferLength(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(), "buffer length must be a number").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    uint32_t seconds = info[0].As<Napi::Number>().Uint32Value();
    if (seconds < 1 || seconds > 600) { Napi::RangeError::New(info.Env(), "buffer length must be between 1 and 600 seconds").ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    std::lock_guard lock(g_stateMutex); g_bufferSeconds = seconds; if (g_ringBuffer) g_ringBuffer->SetMaxDuration(seconds, g_fps); return info.Env().Undefined();
}
} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    napi_add_env_cleanup_hook(env, Cleanup, nullptr);
    exports.Set("initialize", Napi::Function::New(env, Initialize));
    exports.Set("startReplayBuffer", Napi::Function::New(env, StartReplayBuffer));
    exports.Set("stopReplayBuffer", Napi::Function::New(env, StopReplayBuffer));
    exports.Set("saveClip", Napi::Function::New(env, SaveClip));
    exports.Set("getStatus", Napi::Function::New(env, GetStatus));
    exports.Set("setCurrentGame", Napi::Function::New(env, SetCurrentGame));
    exports.Set("setBufferLength", Napi::Function::New(env, SetBufferLength));
    return exports;
}
NODE_API_MODULE(flash_capture, Init)
