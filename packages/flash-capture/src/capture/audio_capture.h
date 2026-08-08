#pragma once

#include <cstdint>
#include <functional>
#include <atomic>
#include <thread>
#include <string>

#ifdef _WIN32
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

struct AudioData {
    float* samples;       // Interleaved float samples
    uint32_t frameCount;  // Number of audio frames
    uint32_t channels;    // Number of channels
    uint32_t sampleRate;  // Sample rate in Hz
    int64_t timestamp_us; // Microseconds since capture start
};

using AudioCallback = std::function<void(const AudioData& audio)>;

class AudioCapture {
public:
    AudioCapture();
    ~AudioCapture();

    // Initialize WASAPI loopback capture (captures game audio)
    bool Initialize();

    // Start capturing audio
    bool Start(AudioCallback callback);

    // Stop capture
    void Stop();

    bool IsCapturing() const { return capturing_.load(); }
    uint32_t GetSampleRate() const { return sampleRate_; }
    uint32_t GetChannels() const { return channels_; }

private:
    void CaptureLoop();

    std::atomic<bool> capturing_{false};
    std::thread captureThread_;
    AudioCallback callback_;
    uint32_t sampleRate_ = 48000;
    uint32_t channels_ = 2;

#ifdef _WIN32
    ComPtr<IMMDeviceEnumerator> enumerator_;
    ComPtr<IMMDevice> device_;
    ComPtr<IAudioClient> audioClient_;
    ComPtr<IAudioCaptureClient> captureClient_;
    HANDLE audioEvent_ = nullptr;
#endif
};

} // namespace flash
