#pragma once
#include "../../core/audio_source.h"

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

class AudioCapture : public AudioSource {
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
