#include "audio_capture.h"
#include "../../core/audio_math.h"
#include "../../core/capture_clock.h"
#include <algorithm>
#include <cmath>
#include <cstring>

#ifdef _WIN32
#include <Windows.h>
#include <audioclientactivationparams.h>
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
AudioCapture::~AudioCapture() { Stop(); }

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
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator_.GetAddressOf()));
    if (FAILED(hr)) return false;
    BuildSources(0); return !sources_.empty();
#else
    return false;
#endif
}

void AudioCapture::BuildSources(uint32_t processId) {
#ifdef _WIN32
    auto game = std::make_shared<Source>(); game->info = {"game", "process", "Game"};
    auto mic = std::make_shared<Source>(); mic->info = {"mic", "microphone", "Microphone"};
    auto other = std::make_shared<Source>(); other->info = {"other", "process", "Other apps"};
    const bool split = InitializeProcess(game, processId, true) && InitializeProcess(other, processId, false);
    InitializeEndpoint(mic, eCapture);
    if (split) { mode_ = "separate"; processError_.clear(); sources_ = {game, mic, other}; }
    else {
        // Keep the reason before the failed sources are discarded, otherwise a
        // fallback to mixed is indistinguishable from "not attempted".
        processError_ = !game->info.error.empty() ? game->info.error : other->info.error;
        auto mixed = std::make_shared<Source>(); mixed->info = {"game", "system", "System mix"}; InitializeEndpoint(mixed, eRender);
        mode_ = "mixed"; sources_ = {mixed, mic};
    }
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
    if (capturing_.exchange(true)) return false; callback_ = std::move(callback);
#ifdef _WIN32
    std::lock_guard lock(mutex_);
    for (auto& source : sources_) if (source->info.available && source->info.enabled && SUCCEEDED(source->client->Start())) {
        source->info.active = true; source->running.store(true);
        source->thread = std::thread(&AudioCapture::CaptureLoop, this, source);
    }
#endif
    return true;
}

void AudioCapture::Stop() {
    capturing_.store(false);
#ifdef _WIN32
    for (auto& source : sources_) { source->running.store(false); if (source->client) source->client->Stop(); if (source->event) SetEvent(source->event); }
    for (auto& source : sources_) { if (source->thread.joinable()) source->thread.join(); source->info.active = false; }
#endif
}

void AudioCapture::CaptureLoop(std::shared_ptr<Source> source) {
#ifdef _WIN32
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
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
    CoUninitialize();
#else
    (void)source;
#endif
}

std::vector<AudioSourceInfo> AudioCapture::ListSources() const {
    std::lock_guard lock(mutex_); std::vector<AudioSourceInfo> result;
    for (const auto& source : sources_) result.push_back(source->info); return result;
}

bool AudioCapture::SetSource(const std::string& id, bool enabled, float gain) {
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
