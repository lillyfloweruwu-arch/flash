#pragma once
#include "../../core/audio_source.h"
#include "../../core/lane_mixer.h"

#include <array>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <atomic>
#include <map>
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
    void SetLanes(const AudioLaneConfig& config) override;
    std::vector<AudioAppInfo> ListApps() const override;
    bool SupportsPerApp() const override { return perApp_; }
    // True when this Windows build can capture one process's audio.
    static bool ProcessLoopbackAvailable();

private:
    struct Source;
    bool InitializeEndpoint(const std::shared_ptr<Source>& source, int flow);
    static bool InitializeProcess(const std::shared_ptr<Source>& source, uint32_t processId, bool include);
    void BuildSources(uint32_t processId);
    void CaptureLoop(std::shared_ptr<Source> source);

    struct App;
    // The three lanes that are mixed from apps, in this order.
    static constexpr std::array<const char*, 3> kMixedLanes{"discord", "music", "other"};
    static int MixedLaneIndex(AudioLane lane);
    void ScanLoop();
    void ScanOnce();
    void MixLoop();
    void AppLoop(std::shared_ptr<App> app);
    void StopApps();

    std::atomic<bool> capturing_{false};
    AudioCallback callback_;
    mutable std::mutex mutex_;
    std::vector<std::shared_ptr<Source>> sources_;
    std::string mode_ = "mixed";
    std::string processError_;

    // Lock order: mutex_ before mixMutex_, never the other way round. scanMutex_
    // is only ever held on its own. None of them is held while a thread is
    // joined or while the callback runs.
    bool perApp_ = false;                 // process loopback works on this Windows build
    uint32_t gamePid_ = 0;                // guarded by mutex_
    AudioLaneConfig lanes_;               // guarded by mutex_
    std::map<uint32_t, std::shared_ptr<App>> apps_;   // by app root pid; guarded by mutex_
    std::array<bool, 3> laneEnabled_{true, true, true};   // guarded by mutex_
    std::thread scanThread_, mixThread_;  // started in Start(), joined in Stop()
    std::condition_variable scanWake_;
    std::mutex scanMutex_;
    bool scanNow_ = false;                // guarded by scanMutex_
    std::mutex mixMutex_;                 // guards mixers_ and every App::lane
    std::array<LaneMixer, 3> mixers_;

#ifdef _WIN32
    ComPtr<IMMDeviceEnumerator> enumerator_;
    // The scanner's own, created and released on its thread.
    ComPtr<IMMDeviceEnumerator> scanEnumerator_;
    bool apartmentInitialized_ = false;
#endif
};

} // namespace flash
