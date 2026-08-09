#pragma once

#include <cstdint>
#include <functional>
#include <atomic>
#include <thread>
#include <string>
#include <memory>
#include <mutex>
#include <vector>

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
    std::string sourceId;
};

struct AudioSourceInfo {
    std::string id, kind, name;
    bool available = false, enabled = true, active = false;
    float gain = 1.0f;
    uint32_t sampleRate = 0, channels = 0, processId = 0;
    std::string error;
};

using AudioCallback = std::function<void(const AudioData& audio)>;

class AudioCapture {
public:
    AudioCapture();
    ~AudioCapture();

    // Initialize WASAPI loopback capture (captures game audio)
    bool Initialize();
    bool SetGameProcess(uint32_t processId);

    // Start capturing audio
    bool Start(AudioCallback callback);

    // Stop capture
    void Stop();

    bool IsCapturing() const { return capturing_.load(); }
    std::vector<AudioSourceInfo> ListSources() const;
    bool SetSource(const std::string& id, bool enabled, float gain);
    std::string GetMode() const;
    // Why per-process splitting fell back to a mixed track, if it did.
    std::string GetProcessError() const;

private:
    struct Source;
    bool InitializeEndpoint(const std::shared_ptr<Source>& source, int flow);
    bool InitializeProcess(const std::shared_ptr<Source>& source, uint32_t processId, bool include);
    void BuildSources(uint32_t processId);
    void CaptureLoop(std::shared_ptr<Source> source);

    std::atomic<bool> capturing_{false};
    AudioCallback callback_;
    mutable std::mutex mutex_;
    std::vector<std::shared_ptr<Source>> sources_;
    std::string mode_ = "mixed";
    std::string processError_;

#ifdef _WIN32
    ComPtr<IMMDeviceEnumerator> enumerator_;
#endif
};

} // namespace flash
