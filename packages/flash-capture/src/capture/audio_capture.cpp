#include "audio_capture.h"
#include <chrono>

#ifdef _WIN32
#include <functiondiscoverykeys_devpkey.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#endif

namespace flash {

AudioCapture::AudioCapture() = default;

AudioCapture::~AudioCapture() {
    Stop();
#ifdef _WIN32
    if (audioEvent_) CloseHandle(audioEvent_);
#endif
}

bool AudioCapture::Initialize() {
#ifdef _WIN32
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // Create device enumerator
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        reinterpret_cast<void**>(enumerator_.GetAddressOf())
    );
    if (FAILED(hr)) return false;

    // Get default audio render device (for loopback capture)
    hr = enumerator_->GetDefaultAudioEndpoint(eRender, eConsole, &device_);
    if (FAILED(hr)) return false;

    // Activate audio client
    hr = device_->Activate(
        __uuidof(IAudioClient),
        CLSCTX_ALL,
        nullptr,
        reinterpret_cast<void**>(audioClient_.GetAddressOf())
    );
    if (FAILED(hr)) return false;

    // Get mix format
    WAVEFORMATEX* mixFormat = nullptr;
    hr = audioClient_->GetMixFormat(&mixFormat);
    if (FAILED(hr)) return false;

    sampleRate_ = mixFormat->nSamplesPerSec;
    channels_ = mixFormat->nChannels;

    // Initialize in loopback mode
    hr = audioClient_->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        10000000, // 1 second buffer
        0,
        mixFormat,
        nullptr
    );
    CoTaskMemFree(mixFormat);
    if (FAILED(hr)) return false;

    // Create event for audio data ready
    audioEvent_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!audioEvent_) return false;

    hr = audioClient_->SetEventHandle(audioEvent_);
    if (FAILED(hr)) return false;

    // Get capture client
    hr = audioClient_->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(captureClient_.GetAddressOf())
    );
    if (FAILED(hr)) return false;

    return true;
#else
    return false;
#endif
}

bool AudioCapture::Start(AudioCallback callback) {
    if (capturing_.load()) return false;

    callback_ = callback;
    capturing_.store(true);

#ifdef _WIN32
    audioClient_->Start();
#endif

    captureThread_ = std::thread(&AudioCapture::CaptureLoop, this);
    return true;
}

void AudioCapture::Stop() {
    capturing_.store(false);
#ifdef _WIN32
    if (audioClient_) audioClient_->Stop();
    if (audioEvent_) SetEvent(audioEvent_); // Wake up capture thread
#endif
    if (captureThread_.joinable()) {
        captureThread_.join();
    }
}

void AudioCapture::CaptureLoop() {
    using clock = std::chrono::high_resolution_clock;
    auto startTime = clock::now();

#ifdef _WIN32
    while (capturing_.load()) {
        DWORD waitResult = WaitForSingleObject(audioEvent_, 100);
        if (waitResult != WAIT_OBJECT_0) continue;
        if (!capturing_.load()) break;

        UINT32 packetLength = 0;
        captureClient_->GetNextPacketSize(&packetLength);

        while (packetLength > 0 && capturing_.load()) {
            BYTE* data = nullptr;
            UINT32 numFrames = 0;
            DWORD flags = 0;

            HRESULT hr = captureClient_->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            auto now = clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - startTime);

            AudioData audioData;
            audioData.samples = reinterpret_cast<float*>(data);
            audioData.frameCount = numFrames;
            audioData.channels = channels_;
            audioData.sampleRate = sampleRate_;
            audioData.timestamp_us = elapsed.count();

            if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                callback_(audioData);
            }

            captureClient_->ReleaseBuffer(numFrames);
            captureClient_->GetNextPacketSize(&packetLength);
        }
    }
#endif
}

} // namespace flash
