#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>
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

class AudioSource {
public:
    virtual ~AudioSource() = default;
    virtual bool Initialize() = 0;
    virtual bool SetGameProcess(uint32_t processId) = 0;
    virtual bool Start(AudioCallback callback) = 0;
    virtual void Stop() = 0;
    virtual bool IsCapturing() const = 0;
    virtual std::vector<AudioSourceInfo> ListSources() const = 0;
    virtual bool SetSource(const std::string& id, bool enabled, float gain) = 0;
    virtual std::string GetMode() const = 0;
    virtual std::string GetProcessError() const = 0;
};
} // namespace flash
