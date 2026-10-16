#include "audio_capture.h"
#include "../../core/audio_math.h"
#include "../../core/capture_clock.h"
#include "../../core/process_list.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

#ifdef _WIN32
#include <Windows.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <wrl/implements.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#endif

namespace flash {

struct AudioCapture::Source {
    AudioSourceInfo info;
#ifdef _WIN32
    ComPtr<IMMDevice> device;
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> capture;
    HANDLE event = nullptr;
#endif
    std::thread thread;
    // Per source, because a source can now be stopped on its own while the
    // others keep recording. capturing_ alone only says whether ALL of them
    // should stop.
    std::atomic<bool> running{false};
    bool isFloat = true;
    uint16_t bits = 32;
    ~Source() {
#ifdef _WIN32
        if (event) CloseHandle(event);
#endif
    }
};

// One app whose sound is captured on its own and mixed into a lane.
struct AudioCapture::App {
    uint32_t rootPid = 0;
    std::string exe, name;
    // Written only by the scanner, holding mutex_ and mixMutex_ together, so
    // either lock is enough to read it.
    AudioLane lane = AudioLane::Other;
    int missedScans = 0;                  // scans in a row with no audio session; guarded by mutex_
#ifdef _WIN32
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> capture;
    HANDLE event = nullptr;
#endif
    std::thread thread;
    // Cleared by whoever stops the app, and by its own thread when the capture
    // fails, which is how the scanner learns it has to be replaced.
    std::atomic<bool> running{false};
    ~App() {
#ifdef _WIN32
        if (event) CloseHandle(event);
#endif
    }
};

#ifdef _WIN32
class ActivationHandler final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
public:
    ActivationHandler() : event_(CreateEvent(nullptr, FALSE, FALSE, nullptr)) {}
    ~ActivationHandler() { if (event_) CloseHandle(event_); }
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activate = E_FAIL;
        operation->GetActivateResult(&activate, &interface_);
        result_ = activate; SetEvent(event_); return S_OK;
    }
    HRESULT Wait(ComPtr<IAudioClient>& client) {
        if (WaitForSingleObject(event_, 5000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        if (SUCCEEDED(result_)) interface_.As(&client);
        return result_;
    }
private:
    HANDLE event_ = nullptr;
    HRESULT result_ = E_PENDING;
    ComPtr<IUnknown> interface_;
};

static std::string DeviceName(IMMDevice* device, const char* fallback) {
    ComPtr<IPropertyStore> store; PROPVARIANT value; PropVariantInit(&value);
    if (device && SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store)) &&
        SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR) {
        int n = WideCharToMultiByte(CP_UTF8, 0, value.pwszVal, -1, nullptr, 0, nullptr, nullptr);
        std::string result(n > 1 ? n - 1 : 0, '\0');
        if (n > 1) WideCharToMultiByte(CP_UTF8, 0, value.pwszVal, -1, result.data(), n, nullptr, nullptr);
        PropVariantClear(&value); return result;
    }
    PropVariantClear(&value); return fallback;
}
#endif

AudioCapture::AudioCapture() = default;
AudioCapture::~AudioCapture() {
    Stop();
#ifdef _WIN32
    // Initialize and destruction run on the owning environment thread. Release
    // every WASAPI interface before balancing that thread's COM initialization.
    sources_.clear();
    enumerator_.Reset();
    if (apartmentInitialized_) CoUninitialize();
#endif
}

bool AudioCapture::InitializeEndpoint(const std::shared_ptr<Source>& source, int flow) {
#ifdef _WIN32
    HRESULT hr = enumerator_->GetDefaultAudioEndpoint(static_cast<EDataFlow>(flow), flow == eCapture ? eCommunications : eConsole, &source->device);
    if (FAILED(hr)) { source->info.error = "default endpoint unavailable"; return false; }
    source->info.name = DeviceName(source->device.Get(), source->info.name.c_str());
    hr = source->device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(source->client.GetAddressOf()));
    if (FAILED(hr)) { source->info.error = "audio client activation failed"; return false; }
    WAVEFORMATEX* format = nullptr; hr = source->client->GetMixFormat(&format);
    if (FAILED(hr)) { source->info.error = "mix format unavailable"; return false; }
    source->info.sampleRate = format->nSamplesPerSec; source->info.channels = format->nChannels; source->bits = format->wBitsPerSample;
    source->isFloat = format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
        (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && reinterpret_cast<WAVEFORMATEXTENSIBLE*>(format)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | (flow == eRender ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0);
    hr = source->client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 10000000, 0, format, nullptr); CoTaskMemFree(format);
    if (FAILED(hr)) { source->info.error = "audio client initialization failed"; return false; }
    source->event = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!source->event || FAILED(source->client->SetEventHandle(source->event)) ||
        FAILED(source->client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(source->capture.GetAddressOf())))) {
        source->info.error = "capture service unavailable"; return false;
    }
    source->info.available = true; source->info.error.clear(); return true;
#else
    (void)source; (void)flow; return false;
#endif
}

bool AudioCapture::InitializeProcess(const std::shared_ptr<Source>& source, uint32_t processId, bool include) {
#ifdef _WIN32
    if (!processId) { source->info.error = "game process is not set"; return false; }
    AUDIOCLIENT_ACTIVATION_PARAMS params{}; params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = processId;
    params.ProcessLoopbackParams.ProcessLoopbackMode = include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT activate{}; activate.vt = VT_BLOB; activate.blob.cbSize = sizeof(params);
    activate.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    auto handler = Microsoft::WRL::Make<ActivationHandler>(); ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activate, handler.Get(), &operation);
    if (FAILED(hr) || FAILED(hr = handler->Wait(source->client))) { source->info.error = "process loopback unavailable"; return false; }
    // GetMixFormat() is NOT supported on a process-loopback client — it fails and
    // takes the whole split down with it. The format has to be stated up front,
    // as Microsoft's own ApplicationLoopback sample does. 48 kHz stereo float
    // matches what the endpoint sources report, so every track shares a rate and
    // the muxer does not have to resample.
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32;
    format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    format.cbSize = 0;
    source->info.sampleRate = format.nSamplesPerSec; source->info.channels = format.nChannels;
    source->bits = format.wBitsPerSample; source->isFloat = true;
    hr = source->client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        10000000, 0, &format, nullptr);
    if (FAILED(hr)) { source->info.error = "process loopback initialization failed"; return false; }
    source->event = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!source->event || FAILED(source->client->SetEventHandle(source->event)) ||
        FAILED(source->client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(source->capture.GetAddressOf())))) {
        source->info.error = "process capture service unavailable"; return false;
    }
    source->info.processId = processId; source->info.available = true; source->info.error.clear(); return true;
#else
    (void)source; (void)processId; return false;
#endif
}

bool AudioCapture::Initialize() {
#ifdef _WIN32
    if (!apartmentInitialized_) {
        const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(apartment) && apartment != RPC_E_CHANGED_MODE) return false;
        apartmentInitialized_ = SUCCEEDED(apartment);
    }
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator_.GetAddressOf()));
    if (FAILED(hr)) return false;
    perApp_ = ProcessLoopbackAvailable();
    BuildSources(0); return !sources_.empty();
#else
    return false;
#endif
}

// Whether process loopback exists at all. Activating a client for our own
// process is enough to tell, and nothing stays open afterwards. Unlike
// Initialize() this never touches the microphone, so the addon can ask at load.
bool AudioCapture::ProcessLoopbackAvailable() {
#ifdef _WIN32
    // Balanced here, so the calling thread is left exactly as it was: S_OK and
    // S_FALSE are both undone, and a thread that is already an STA
    // (RPC_E_CHANGED_MODE) is not touched at all. The activation works there too.
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool available = false;
    {
        auto probe = std::make_shared<Source>();
        available = InitializeProcess(probe, GetCurrentProcessId(), true);
    }   // released before COM is balanced
    if (SUCCEEDED(apartment)) CoUninitialize();
    return available;
#else
    return false;
#endif
}

void AudioCapture::BuildSources(uint32_t processId) {
#ifdef _WIN32
    auto mic = std::make_shared<Source>(); mic->info = {"mic", "microphone", "Microphone"};
    InitializeEndpoint(mic, eCapture);
    std::vector<std::shared_ptr<Source>> sources; std::string mode, error; uint32_t gamePid = 0;
    if (perApp_) {
        // Every other app is captured on its own by the scanner, so the only
        // process source built here is the game's.
        mode = "separate";
        if (processId) {
            auto game = std::make_shared<Source>(); game->info = {"game", "process", "Game"};
            if (InitializeProcess(game, processId, true)) { sources.push_back(game); gamePid = processId; }
            // Without a game source the lanes still work. The pid is forgotten
            // too, so the scanner does not set that tree aside for a source
            // that does not exist.
            else error = game->info.error;
        }
        sources.push_back(mic);
    } else {
        // Keep the reason, otherwise a fallback to mixed is indistinguishable
        // from "not attempted".
        error = "process loopback unavailable";
        auto mixed = std::make_shared<Source>(); mixed->info = {"game", "system", "System mix"}; InitializeEndpoint(mixed, eRender);
        mode = "mixed"; sources = {mixed, mic};
    }
    // Only called with the scanner stopped; the lock is for the readers.
    std::lock_guard lock(mutex_);
    gamePid_ = gamePid; mode_ = std::move(mode); processError_ = std::move(error); sources_ = std::move(sources);
#else
    (void)processId;
#endif
}

bool AudioCapture::SetGameProcess(uint32_t processId) {
    const bool wasCapturing = capturing_.load(); AudioCallback callback = callback_; Stop();
    sources_.clear(); BuildSources(processId);
    if (wasCapturing) Start(std::move(callback)); return mode_ == "separate";
}

std::string AudioCapture::GetMode() const { std::lock_guard lock(mutex_); return mode_; }

std::string AudioCapture::GetProcessError() const { std::lock_guard lock(mutex_); return processError_; }

bool AudioCapture::Start(AudioCallback callback) {
    // Stop() joined the mixer thread, so nothing is reading callback_ here.
    if (capturing_.exchange(true)) return false; callback_ = std::move(callback);
#ifdef _WIN32
    {
        std::lock_guard lock(mutex_);
        for (auto& source : sources_) if (source->info.available && source->info.enabled && SUCCEEDED(source->client->Start())) {
            source->info.active = true; source->running.store(true);
            source->thread = std::thread(&AudioCapture::CaptureLoop, this, source);
        }
    }
    if (perApp_) {
        { std::lock_guard mix(mixMutex_); mixers_ = {}; }
        { std::lock_guard wake(scanMutex_); scanNow_ = false; }
        scanThread_ = std::thread(&AudioCapture::ScanLoop, this);
        mixThread_ = std::thread(&AudioCapture::MixLoop, this);
    }
#endif
    return true;
}

void AudioCapture::Stop() {
    capturing_.store(false);
    // The scanner starts and stops app captures, so it goes first; then the
    // mixer, which is the only lane thread that uses the callback; then the
    // apps, which nothing can add to any more. No lock is held across a join.
    { std::lock_guard wake(scanMutex_); scanNow_ = true; }
    scanWake_.notify_all();
    if (scanThread_.joinable()) scanThread_.join();
    if (mixThread_.joinable()) mixThread_.join();
    StopApps();
#ifdef _WIN32
    for (auto& source : sources_) { source->running.store(false); if (source->client) source->client->Stop(); if (source->event) SetEvent(source->event); }
    for (auto& source : sources_) { if (source->thread.joinable()) source->thread.join(); source->info.active = false; }
#endif
}

void AudioCapture::StopApps() {
    std::map<uint32_t, std::shared_ptr<App>> apps;
    { std::lock_guard lock(mutex_); apps.swap(apps_); }
    for (auto& entry : apps) {
        auto& app = entry.second;
        app->running.store(false);
#ifdef _WIN32
        if (app->client) app->client->Stop();
        if (app->event) SetEvent(app->event);
#endif
    }
    for (auto& entry : apps) if (entry.second->thread.joinable()) entry.second->thread.join();
}

int AudioCapture::MixedLaneIndex(AudioLane lane) {
    return lane == AudioLane::Discord ? 0 : lane == AudioLane::Music ? 1 : lane == AudioLane::Other ? 2 : -1;
}

void AudioCapture::ScanLoop() {
#ifdef _WIN32
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    // Its own enumerator rather than enumerator_, which belongs to the thread
    // that called Initialize() and may live in a different apartment.
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(scanEnumerator_.GetAddressOf())))) {
        // Without it no audio session is ever seen, so say why nothing is captured.
        std::lock_guard lock(mutex_);
        processError_ = "the list of audio devices is unavailable, so no app's sound is recorded";
    }
    while (capturing_.load()) {
        ScanOnce();
        std::unique_lock lock(scanMutex_);
        scanWake_.wait_for(lock, std::chrono::seconds(2), [this] { return scanNow_ || !capturing_.load(); });
        scanNow_ = false;
    }
    scanEnumerator_.Reset();
    if (SUCCEEDED(apartment)) CoUninitialize();
#endif
}

void AudioCapture::ScanOnce() {
#ifdef _WIN32
    // Every process that has an audio session on any active output device.
    std::vector<uint32_t> sessionPids;
    ComPtr<IMMDeviceCollection> devices;
    if (scanEnumerator_ && SUCCEEDED(scanEnumerator_->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) {
        UINT deviceCount = 0; devices->GetCount(&deviceCount);
        for (UINT d = 0; d < deviceCount; ++d) {
            ComPtr<IMMDevice> device; ComPtr<IAudioSessionManager2> manager; ComPtr<IAudioSessionEnumerator> sessions;
            if (FAILED(devices->Item(d, &device))) continue;
            if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                    reinterpret_cast<void**>(manager.GetAddressOf())))) continue;
            if (FAILED(manager->GetSessionEnumerator(&sessions))) continue;
            int count = 0; sessions->GetCount(&count);
            for (int i = 0; i < count; ++i) {
                ComPtr<IAudioSessionControl> control; ComPtr<IAudioSessionControl2> control2;
                if (FAILED(sessions->GetSession(i, &control)) || FAILED(control.As(&control2))) continue;
                if (control2->IsSystemSoundsSession() == S_OK) continue;   // belongs to no app
                AudioSessionState state = AudioSessionStateExpired;
                if (FAILED(control->GetState(&state)) || state == AudioSessionStateExpired) continue;
                DWORD pid = 0;
                if (SUCCEEDED(control2->GetProcessId(&pid)) && pid) sessionPids.push_back(pid);
            }
        }
    }

    const ProcessSnapshot snapshot = ListProcesses();
    const auto& processes = snapshot.processes;
    // An empty list is a failed listing, not a machine with nothing running.
    // Taken at its word it would mark every app dead and restart them all.
    if (processes.empty()) return;
    const uint32_t selfRoot = AppRoot(GetCurrentProcessId(), processes);
    AudioLaneConfig config; uint32_t gamePid;
    { std::lock_guard lock(mutex_); config = lanes_; gamePid = gamePid_; }

    // The apps that should be captured right now, by root pid.
    struct Wanted { std::string exe, name; AudioLane lane; };
    std::map<uint32_t, Wanted> wanted;
    for (uint32_t pid : sessionPids) {
        const uint32_t root = AppRoot(pid, processes);
        if (wanted.count(root)) continue;
        const auto found = std::find_if(processes.begin(), processes.end(),
            [&](const ProcessInfo& p) { return p.pid == root; });
        if (found == processes.end()) continue;   // exited between the two listings
        // Asked of the process that owns the session, not of its app root: the
        // game can be a child of a launcher with the same name, and its root
        // then sits above the game's tree.
        const AudioLane lane = LaneForApp(found->exe, IsInProcessTree(pid, gamePid, processes),
                                          IsInProcessTree(pid, selfRoot, processes), config);
        if (MixedLaneIndex(lane) < 0) continue;   // the game has its own source; Flash is not recorded
        wanted[root] = {found->exe, found->windowTitle.empty() ? found->exe : found->windowTitle, lane};
    }

    // Descendants win. A capture takes a whole process tree, so an app with the
    // game or another wanted app beneath it (Steam above a game it started)
    // would record that sound a second time. Such an app is not captured, and
    // its own sound is given up. Judged against every wanted app, including
    // ones that are dropped themselves, so the deepest of a chain is the one
    // that stays. Flash counts as one of them, though it is never captured:
    // an app above Flash (explorer or a launcher above an autostarted Flash, a
    // terminal above a dev build) would otherwise record Flash with it.
    std::vector<uint32_t> wantedRoots, shadowed;
    for (const auto& entry : wanted) wantedRoots.push_back(entry.first);
    std::vector<uint32_t> beneath = wantedRoots;
    beneath.push_back(selfRoot);
    for (uint32_t root : wantedRoots)
        if (HasCapturedDescendant(root, beneath, gamePid, processes)) shadowed.push_back(root);
    for (uint32_t root : shadowed) wanted.erase(root);
    const auto isShadowed = [&](uint32_t root) { return std::find(shadowed.begin(), shadowed.end(), root) != shadowed.end(); };

    std::vector<std::shared_ptr<App>> stopping, starting;
    bool tooMany = false;
    {
        std::lock_guard lock(mutex_);
        for (auto it = apps_.begin(); it != apps_.end();) {
            auto& app = it->second;
            const auto want = wanted.find(it->first);
            const bool alive = std::any_of(processes.begin(), processes.end(),
                [&](const ProcessInfo& p) { return p.pid == it->first; });
            app->missedScans = want == wanted.end() ? app->missedScans + 1 : 0;
            // Gone, silent for 30 s (15 scans), now above another captured app,
            // or its capture gave up. In the last case it is still wanted and
            // is started afresh just below.
            if (!alive || app->missedScans >= 15 || isShadowed(it->first) || !app->running.load()) { stopping.push_back(app); it = apps_.erase(it); continue; }
            if (want != wanted.end() && want->second.lane != app->lane) {
                // Reassigned in Settings: its audio moves lane from now on.
                std::lock_guard mix(mixMutex_);
                mixers_[MixedLaneIndex(app->lane)].Remove(app->rootPid);
                app->lane = want->second.lane;
            }
            ++it;
        }
        for (const auto& entry : wanted) {
            if (apps_.count(entry.first)) continue;
            if (apps_.size() >= 16) { tooMany = true; break; }
            auto app = std::make_shared<App>();
            app->rootPid = entry.first; app->exe = entry.second.exe; app->name = entry.second.name; app->lane = entry.second.lane;
            apps_[entry.first] = app;
            starting.push_back(app);
        }
        if (tooMany) processError_ = "more than 16 apps are making sound; some are not recorded";
        else if (processError_.rfind("more than 16", 0) == 0) processError_.clear();
    }

    for (auto& app : stopping) {
        app->running.store(false);
        if (app->client) app->client->Stop();
        if (app->event) SetEvent(app->event);
        if (app->thread.joinable()) app->thread.join();
        std::lock_guard mix(mixMutex_);
        mixers_[MixedLaneIndex(app->lane)].Remove(app->rootPid);
    }
    for (auto& app : starting) {
        // The same activation the game source uses, pointed at this app's tree.
        // Once capturing_ is false Stop() is waiting for this thread, so the
        // rest are not started.
        auto source = std::make_shared<Source>();
        if (!capturing_.load() || !InitializeProcess(source, app->rootPid, true)) {
            std::lock_guard lock(mutex_); apps_.erase(app->rootPid);   // tried again on the next scan
            continue;
        }
        app->client = source->client; app->capture = source->capture;
        app->event = source->event; source->event = nullptr;          // the App owns the handle now
        if (FAILED(app->client->Start())) { std::lock_guard lock(mutex_); apps_.erase(app->rootPid); continue; }
        app->running.store(true);
        app->thread = std::thread(&AudioCapture::AppLoop, this, app);
    }
#endif
}

// An app's capture thread. The same buffer handling as CaptureLoop, but the
// audio goes to its lane's mixer instead of the callback. Process loopback is
// always 48 kHz stereo float (see InitializeProcess), so nothing is converted.
void AudioCapture::AppLoop(std::shared_ptr<App> app) {
#ifdef _WIN32
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool failed = false;
    while (!failed && capturing_.load() && app->running.load()) {
        if (WaitForSingleObject(app->event, 100) != WAIT_OBJECT_0) continue;
        UINT32 packet = 0;
        if (FAILED(app->capture->GetNextPacketSize(&packet))) { failed = true; break; }
        while (packet && capturing_.load() && app->running.load()) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            if (FAILED(app->capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) { failed = true; break; }
            if (frames && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                const int64_t startUs = CaptureClockUs() - static_cast<int64_t>(frames) * 1000000 / 48000;
                // The lane is read under the mixer's lock, so a reassignment
                // cannot slip in between choosing the mixer and pushing to it.
                std::lock_guard mix(mixMutex_);
                const int index = MixedLaneIndex(app->lane);
                if (index >= 0) mixers_[index].Push(app->rootPid, reinterpret_cast<const float*>(data), frames, startUs);
            }
            app->capture->ReleaseBuffer(frames);
            if (FAILED(app->capture->GetNextPacketSize(&packet))) { failed = true; break; }
        }
    }
    // A capture that failed ends its own thread; the next scan replaces it.
    if (failed) app->running.store(false);
    if (SUCCEEDED(apartment)) CoUninitialize();
#else
    (void)app;
#endif
}

void AudioCapture::MixLoop() {
    std::vector<LaneMixer::Packet> packets;
    while (capturing_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        std::array<bool, 3> enabled;
        { std::lock_guard lock(mutex_); enabled = laneEnabled_; }
        for (size_t lane = 0; lane < mixers_.size(); ++lane) {
            packets.clear();
            { std::lock_guard mix(mixMutex_); mixers_[lane].Pull(CaptureClockUs(), packets); }
            // Pulled even when the lane is off, so its timeline keeps moving
            // and nothing stale comes out when it is switched back on.
            if (!enabled[lane] || !callback_) continue;
            for (auto& packet : packets) {
                AudioData value{packet.samples.data(), LaneMixer::kPacketFrames, LaneMixer::kChannels,
                                LaneMixer::kRate, packet.startUs, kMixedLanes[lane]};
                callback_(value);
            }
        }
    }
}

void AudioCapture::SetLanes(const AudioLaneConfig& config) {
    { std::lock_guard lock(mutex_); lanes_ = config; }
    { std::lock_guard lock(scanMutex_); scanNow_ = true; }
    scanWake_.notify_all();
}

std::vector<AudioAppInfo> AudioCapture::ListApps() const {
    std::lock_guard lock(mutex_); std::vector<AudioAppInfo> result;
    for (const auto& entry : apps_) {
        const auto& app = entry.second;
        result.push_back({app->exe, app->name, std::string(AudioLaneTrack(app->lane)), app->rootPid,
                          app->running.load() && app->missedScans == 0});
    }
    return result;
}

void AudioCapture::CaptureLoop(std::shared_ptr<Source> source) {
#ifdef _WIN32
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (capturing_.load() && source->running.load()) {
        if (WaitForSingleObject(source->event, 100) != WAIT_OBJECT_0) continue;
        UINT32 packet = 0; source->capture->GetNextPacketSize(&packet);
        while (packet && capturing_.load() && source->running.load()) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0; UINT64 position = 0;
            HRESULT hr = source->capture->GetBuffer(&data, &frames, &flags, &position, nullptr); if (FAILED(hr)) break;
            (void)position;  // see the timestamp note below
            std::vector<float> converted(static_cast<size_t>(frames) * source->info.channels, 0.0f);
            if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                if (source->isFloat) std::memcpy(converted.data(), data, converted.size() * sizeof(float));
                else if (source->bits == 16) { auto* pcm = reinterpret_cast<int16_t*>(data); for (size_t i = 0; i < converted.size(); ++i) converted[i] = pcm[i] / 32768.0f; }
            }
            auto stereo = ResampleStereo(converted.data(), frames, source->info.channels, source->info.sampleRate);
            float gain; bool enabled; { std::lock_guard lock(mutex_); gain = source->info.gain; enabled = source->info.enabled; }
            for (float& sample : stereo) sample = (std::max)(-1.0f, (std::min)(1.0f, sample * gain));
            // Timestamp from the shared capture clock, NOT from the WASAPI device
            // position. A process-loopback client does not report a meaningful
            // position — it stays put — so position-derived timestamps put every
            // packet at the same instant. The muxer then waits forever for that
            // track's timeline to advance while video runs ahead, and saveClip
            // hangs. Wall clock is monotonic, represents silent gaps honestly,
            // and is the same clock the video frames are stamped with.
            const uint32_t frameCount = static_cast<uint32_t>(stereo.size() / 2);
            const int64_t startUs = CaptureClockUs() - static_cast<int64_t>(frameCount) * 1000000 / 48000;
            AudioData value{stereo.data(), frameCount, 2, 48000, startUs, source->info.id};
            if (enabled && callback_ && value.frameCount) callback_(value);
            source->capture->ReleaseBuffer(frames); source->capture->GetNextPacketSize(&packet);
        }
    }
    if (SUCCEEDED(apartment)) CoUninitialize();
#else
    (void)source;
#endif
}

std::vector<AudioSourceInfo> AudioCapture::ListSources() const {
    std::lock_guard lock(mutex_); std::vector<AudioSourceInfo> result;
    for (const auto& source : sources_) result.push_back(source->info);
    if (perApp_) {
        // The three mixed lanes, so the list stays a complete picture.
        static constexpr std::array<const char*, 3> names{"Discord", "Music", "Other apps"};
        for (size_t lane = 0; lane < kMixedLanes.size(); ++lane) {
            AudioSourceInfo info; info.id = kMixedLanes[lane]; info.kind = "apps"; info.name = names[lane];
            info.available = true; info.enabled = laneEnabled_[lane]; info.sampleRate = 48000; info.channels = 2;
            info.active = std::any_of(apps_.begin(), apps_.end(), [&](const auto& entry) {
                return MixedLaneIndex(entry.second->lane) == static_cast<int>(lane); });
            result.push_back(std::move(info));
        }
    }
    return result;
}

bool AudioCapture::SetSource(const std::string& id, bool enabled, float gain) {
    for (size_t lane = 0; lane < kMixedLanes.size(); ++lane) {
        if (id != kMixedLanes[lane]) continue;
        // On the system-mix fallback there is no such lane, and saying so would
        // make "Record audio" report a failure for something that is fine.
        std::lock_guard lock(mutex_); laneEnabled_[lane] = enabled; return true;
    }
    std::shared_ptr<Source> target;
    {
        std::lock_guard lock(mutex_);
        for (auto& source : sources_) if (source->info.id == id) { target = source; break; }
        if (!target) return false;
        target->info.gain = (std::max)(0.0f, (std::min)(4.0f, gain));
        if (target->info.enabled == enabled) return true;
        target->info.enabled = enabled;
    }
#ifdef _WIN32
    // Enabling and disabling start and stop the device, rather than only
    // flipping a flag. Both halves matter:
    //
    // Leaving a disabled source running would hold the microphone open after
    // the user turned it off, and Windows shows that to them as "in use".
    // Leaving it merely flagged, which is what this did before, means it can
    // never be turned back on — Start() is the only thing that ever created a
    // source's thread, and it skips the ones that were disabled at the time.
    if (!capturing_.load() || !target->info.available || !target->client) return true;
    if (enabled) {
        if (target->running.exchange(true)) return true;
        if (FAILED(target->client->Start())) { target->running.store(false); return true; }
        if (target->thread.joinable()) target->thread.join();
        target->thread = std::thread(&AudioCapture::CaptureLoop, this, target);
        std::lock_guard lock(mutex_); target->info.active = true;
    } else {
        if (!target->running.exchange(false)) return true;
        // The loop waits up to 100ms on this event, so wake it rather than
        // waiting out the timeout with the JS thread blocked in here.
        if (target->event) SetEvent(target->event);
        if (target->thread.joinable()) target->thread.join();
        target->client->Stop();
        std::lock_guard lock(mutex_); target->info.active = false;
    }
#endif
    return true;
}
} // namespace flash
