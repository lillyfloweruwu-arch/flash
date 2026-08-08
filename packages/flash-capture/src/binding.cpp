#include <napi.h>
#include "capture/screen_capture.h"
#include "capture/audio_capture.h"
#include "encoding/encoder.h"
#include "buffer/ring_buffer.h"
#include "buffer/clip_writer.h"

#include <memory>
#include <string>

using namespace flash;

// Global capture state
static std::unique_ptr<ScreenCapture> g_screenCapture;
static std::unique_ptr<AudioCapture> g_audioCapture;
static std::unique_ptr<Encoder> g_encoder;
static std::unique_ptr<RingBuffer> g_ringBuffer;
static std::string g_clipsDir;
static std::string g_currentGame = "Unknown";

// ── Initialize capture system ─────────────────────────────────────────────────

Napi::Value Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Get clips directory from argument
    if (info.Length() > 0 && info[0].IsString()) {
        g_clipsDir = info[0].As<Napi::String>().Utf8Value();
    }

    // Detect GPU and create encoder
    GpuVendor vendor = DetectGpuVendor();
    g_encoder = CreateEncoder();

    // Initialize screen capture
    g_screenCapture = std::make_unique<ScreenCapture>();
    bool screenOk = g_screenCapture->Initialize(60);

    // Initialize audio capture
    g_audioCapture = std::make_unique<AudioCapture>();
    bool audioOk = g_audioCapture->Initialize();

    // Create ring buffer (30 seconds at 60fps)
    g_ringBuffer = std::make_unique<RingBuffer>(30, 60);

    // Return status object
    auto result = Napi::Object::New(env);
    result.Set("screenCapture", Napi::Boolean::New(env, screenOk));
    result.Set("audioCapture", Napi::Boolean::New(env, audioOk));
    result.Set("encoder", Napi::String::New(env, g_encoder ? g_encoder->GetName() : "none"));
    result.Set("hwAccel", Napi::Boolean::New(env, g_encoder && g_encoder->IsHardwareAccelerated()));

    std::string vendorStr = "unknown";
    switch (vendor) {
        case GpuVendor::Nvidia: vendorStr = "nvidia"; break;
        case GpuVendor::Amd: vendorStr = "amd"; break;
        case GpuVendor::Intel: vendorStr = "intel"; break;
        default: break;
    }
    result.Set("gpu", Napi::String::New(env, vendorStr));
    result.Set("width", Napi::Number::New(env, g_screenCapture ? g_screenCapture->GetWidth() : 0));
    result.Set("height", Napi::Number::New(env, g_screenCapture ? g_screenCapture->GetHeight() : 0));

    return result;
}

// ── Start replay buffer ───────────────────────────────────────────────────────

Napi::Value StartReplayBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_screenCapture || !g_encoder || !g_ringBuffer) {
        return Napi::Boolean::New(env, false);
    }

    // Start screen capture with encoding callback
    bool ok = g_screenCapture->Start([](const FrameData& frame) {
        if (g_encoder && g_ringBuffer) {
            EncodedPacket packet;
            if (g_encoder->EncodeFrame(frame, packet)) {
                g_ringBuffer->Push(packet);
            }
        }
    });

    // Start audio capture
    if (g_audioCapture) {
        g_audioCapture->Start([](const AudioData& audio) {
            // TODO: Store audio in separate ring buffer for muxing
        });
    }

    return Napi::Boolean::New(env, ok);
}

// ── Stop replay buffer ────────────────────────────────────────────────────────

Napi::Value StopReplayBuffer(const Napi::CallbackInfo& info) {
    if (g_screenCapture) g_screenCapture->Stop();
    if (g_audioCapture) g_audioCapture->Stop();
    return info.Env().Undefined();
}

// ── Save clip (flush ring buffer to file) ─────────────────────────────────────

Napi::Value SaveClip(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_ringBuffer) {
        return env.Null();
    }

    auto packets = g_ringBuffer->Flush();
    if (packets.empty()) {
        return env.Null();
    }

    // Generate output path
    std::string outputPath = ClipWriter::GenerateClipPath(g_clipsDir, g_currentGame);

    // Write clip
    ClipWriter writer;
    auto meta = writer.Write(
        outputPath, packets, {},
        g_screenCapture ? g_screenCapture->GetWidth() : 1920,
        g_screenCapture ? g_screenCapture->GetHeight() : 1080,
        60, g_currentGame
    );

    // Return clip metadata
    auto result = Napi::Object::New(env);
    result.Set("path", Napi::String::New(env, meta.filePath));
    result.Set("duration", Napi::Number::New(env, meta.durationSeconds));
    result.Set("game", Napi::String::New(env, meta.game));
    result.Set("width", Napi::Number::New(env, meta.width));
    result.Set("height", Napi::Number::New(env, meta.height));

    return result;
}

// ── Get capture status ────────────────────────────────────────────────────────

Napi::Value GetStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto result = Napi::Object::New(env);

    result.Set("recording", Napi::Boolean::New(env,
        g_screenCapture && g_screenCapture->IsCapturing()));
    result.Set("bufferSeconds", Napi::Number::New(env,
        g_ringBuffer ? g_ringBuffer->GetDurationSeconds() : 0));
    result.Set("encoder", Napi::String::New(env,
        g_encoder ? g_encoder->GetName() : "none"));

    return result;
}

// ── Set current game ──────────────────────────────────────────────────────────

Napi::Value SetCurrentGame(const Napi::CallbackInfo& info) {
    if (info.Length() > 0 && info[0].IsString()) {
        g_currentGame = info[0].As<Napi::String>().Utf8Value();
    }
    return info.Env().Undefined();
}

// ── Set buffer length ─────────────────────────────────────────────────────────

Napi::Value SetBufferLength(const Napi::CallbackInfo& info) {
    if (info.Length() > 0 && info[0].IsNumber()) {
        uint32_t seconds = info[0].As<Napi::Number>().Uint32Value();
        if (g_ringBuffer) {
            g_ringBuffer->SetMaxDuration(seconds, 60);
        }
    }
    return info.Env().Undefined();
}

// ── Module init ───────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
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
