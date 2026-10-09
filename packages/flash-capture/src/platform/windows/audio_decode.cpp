#include "../../core/audio_decode.h"
#include "../../core/audio_tracks.h"

#include <algorithm>
#include <stdexcept>

#ifdef _WIN32
#include <Windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <propvarutil.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif

namespace flash {

#ifdef _WIN32
namespace {

std::wstring ToWide(const std::string& value) {
    if (value.empty()) return {};
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0);
    if (!count) throw std::runtime_error("clip path is not valid UTF-8");
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), count);
    return result;
}

void Check(HRESULT hr, const char* operation) {
    if (FAILED(hr)) throw std::runtime_error(std::string(operation) + " failed (HRESULT " +
        std::to_string(static_cast<unsigned long>(hr)) + ")");
}

struct MfScope {
    MfScope() {
        apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(apartment) && apartment != RPC_E_CHANGED_MODE) Check(apartment, "CoInitializeEx");
        Check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "MFStartup");
        started = true;
    }
    ~MfScope() {
        if (started) MFShutdown();
        if (SUCCEEDED(apartment)) CoUninitialize();
    }
    HRESULT apartment = E_FAIL;
    bool started = false;
};

} // namespace
#endif

std::vector<DecodedTrack> DecodeClipAudio(const std::string& path, uint32_t targetRate) {
#ifdef _WIN32
    MfScope mf;
    ComPtr<IMFSourceReader> reader;
    const auto widePath = ToWide(path);
    Check(MFCreateSourceReaderFromURL(widePath.c_str(), nullptr, &reader),
        "MFCreateSourceReaderFromURL");
    Check(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE),
        "deselect source streams");

    std::vector<DWORD> audioStreams;
    for (DWORD index = 0;; ++index) {
        ComPtr<IMFMediaType> type;
        const HRESULT result = reader->GetNativeMediaType(index, 0, &type);
        if (result == MF_E_INVALIDSTREAMNUMBER) break;
        Check(result, "IMFSourceReader::GetNativeMediaType");
        GUID major{};
        if (SUCCEEDED(type->GetGUID(MF_MT_MAJOR_TYPE, &major)) && major == MFMediaType_Audio)
            audioStreams.push_back(index);
    }

    const size_t trackCount = (std::min)(audioStreams.size(), kAudioTrackOrder.size());
    std::vector<DecodedTrack> tracks;
    tracks.reserve(trackCount);
    for (size_t position = 0; position < trackCount; ++position) {
        tracks.push_back({std::string(kAudioTrackOrder[position]), {}});
        const DWORD stream = audioStreams[position];
        if (FAILED(reader->SetStreamSelection(stream, TRUE))) continue;

        ComPtr<IMFMediaType> requestedType;
        if (FAILED(MFCreateMediaType(&requestedType)) ||
            FAILED(requestedType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio)) ||
            FAILED(requestedType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float)) ||
            FAILED(reader->SetCurrentMediaType(stream, nullptr, requestedType.Get()))) {
            reader->SetStreamSelection(stream, FALSE);
            continue;
        }

        ComPtr<IMFMediaType> actualType;
        UINT32 channels = 0;
        UINT32 sourceRate = 0;
        if (FAILED(reader->GetCurrentMediaType(stream, &actualType)) ||
            FAILED(actualType->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels)) ||
            FAILED(actualType->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &sourceRate)) ||
            !channels || !sourceRate) {
            reader->SetStreamSelection(stream, FALSE);
            continue;
        }

        PROPVARIANT positionValue;
        PropVariantInit(&positionValue);
        positionValue.vt = VT_I8;
        positionValue.hVal.QuadPart = 0;
        const HRESULT seekResult = reader->SetCurrentPosition(GUID_NULL, positionValue);
        PropVariantClear(&positionValue);
        if (FAILED(seekResult)) {
            reader->SetStreamSelection(stream, FALSE);
            continue;
        }

        std::vector<float> mono;
        bool decoded = true;
        for (;;) {
            DWORD actualStream = 0;
            DWORD flags = 0;
            LONGLONG timestamp = 0;
            ComPtr<IMFSample> sample;
            if (FAILED(reader->ReadSample(stream, 0, &actualStream, &flags, &timestamp, &sample)) ||
                (flags & MF_SOURCE_READERF_ERROR)) {
                decoded = false;
                break;
            }
            if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
            if (flags & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED |
                MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED)) {
                decoded = false;
                break;
            }
            if (!sample) continue;

            ComPtr<IMFMediaBuffer> buffer;
            if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) {
                decoded = false;
                break;
            }
            BYTE* data = nullptr;
            DWORD length = 0;
            if (FAILED(buffer->Lock(&data, nullptr, &length))) {
                decoded = false;
                break;
            }
            const size_t frameBytes = static_cast<size_t>(channels) * sizeof(float);
            if (length % frameBytes != 0) {
                buffer->Unlock();
                decoded = false;
                break;
            }
            const size_t frameCount = length / frameBytes;
            const float* samples = reinterpret_cast<const float*>(data);
            mono.reserve(mono.size() + frameCount);
            for (size_t frame = 0; frame < frameCount; ++frame)
                mono.push_back(DownmixToMono(samples + frame * channels, channels));
            if (FAILED(buffer->Unlock())) {
                decoded = false;
                break;
            }
        }
        reader->SetStreamSelection(stream, FALSE);
        if (decoded) ResampleLinear(mono, sourceRate, targetRate, tracks.back().samples);
    }
    return tracks;
#else
    (void)path;
    (void)targetRate;
    return {};
#endif
}

} // namespace flash
