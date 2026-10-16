#pragma once
// The audio streams of an MP4, in the order the file holds them.
//
// A clip's tracks are identified by position: game, mic, other, discord, music,
// in the order the writer added them, which is the order of the `trak` boxes
// and the order ffmpeg and every player report. The source reader does not
// list them that way. Its stream numbers are its own, they are not the file's
// track ids, and for a clip Flash wrote the audio streams come out backwards,
// which showed the game under "Other" and other apps under "Game".
//
// Nothing the reader exposes ties one of its streams to a track, so the two
// are matched on what the file itself says about each track: the byte size of
// every sample, from the track's `stsz` table (core/mp4_track_table.h), against
// the sizes of the samples the reader hands back undecoded. Two tracks whose
// sizes agree from the first sample to the last are both encoded silence, and
// telling those apart does not matter.
#include "../../core/mp4_track_table.h"

#include <Windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace flash {

struct AudioStreamOrder {
    std::vector<DWORD> streams;   // the reader's audio stream numbers
    // True when `streams` is in file order. False means the reader's own order,
    // which is not the file's: a caller that writes the tracks out must refuse.
    bool matched = false;
};

namespace audio_track_order_detail {

inline std::vector<uint8_t> ReadMoov(const std::wstring& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return {};
    file.seekg(0, std::ios::end);
    const auto end = file.tellg();
    if (end < 0) return {};
    return ReadMp4Moov(static_cast<uint64_t>(end), [&](uint64_t offset, uint8_t* buffer, size_t length) {
        file.clear();
        file.seekg(static_cast<std::streamoff>(offset));
        return static_cast<bool>(file.read(reinterpret_cast<char*>(buffer), static_cast<std::streamsize>(length)));
    });
}

// Which track one reader stream is, among the tracks not placed yet. -1 when
// none fits. Reads only as far as it takes to leave one candidate.
inline int MatchStream(IMFSourceReader* reader, DWORD stream, const std::vector<Mp4AudioTrack>& tracks,
                       const std::vector<bool>& placed) {
    using Microsoft::WRL::ComPtr;
    std::vector<size_t> candidates;
    for (size_t t = 0; t < tracks.size(); ++t) if (!placed[t]) candidates.push_back(t);
    if (candidates.size() <= 1) return candidates.empty() ? -1 : static_cast<int>(candidates.front());
    if (FAILED(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE)) ||
        FAILED(reader->SetStreamSelection(stream, TRUE))) return -1;
    PROPVARIANT start; PropVariantInit(&start); start.vt = VT_I8; start.hVal.QuadPart = 0;
    const HRESULT seek = reader->SetCurrentPosition(GUID_NULL, start);
    PropVariantClear(&start);
    if (FAILED(seek)) return -1;
    uint32_t index = 0;
    for (;;) {
        DWORD actual = 0, flags = 0; LONGLONG time = 0; ComPtr<IMFSample> sample;
        if (FAILED(reader->ReadSample(stream, 0, &actual, &flags, &time, &sample)) ||
            (flags & MF_SOURCE_READERF_ERROR)) return -1;
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
            // Read to the end with more than one left: those tracks are the same
            // size sample for sample. Only ones of exactly this length qualify.
            candidates.erase(std::remove_if(candidates.begin(), candidates.end(),
                [&](size_t t) { return tracks[t].count != index; }), candidates.end());
            return candidates.empty() ? -1 : static_cast<int>(candidates.front());
        }
        if (!sample) continue;
        DWORD length = 0;
        if (FAILED(sample->GetTotalLength(&length))) return -1;
        candidates.erase(std::remove_if(candidates.begin(), candidates.end(), [&](size_t t) {
            return index >= tracks[t].count || tracks[t].SizeAt(index) != length;
        }), candidates.end());
        if (candidates.size() <= 1) return candidates.empty() ? -1 : static_cast<int>(candidates.front());
        if (++index > kMp4MaxTrackSamples) return -1;
    }
}

} // namespace audio_track_order_detail

// The reader's audio stream numbers for `path`, ordered as the file orders its
// audio tracks. Stream numbers are the same in every source reader opened on
// the same file. Needs Media Foundation started on the calling thread.
//
// When the match cannot be made (not an MP4, a fragmented one, a track the
// reader hides, a file over the parser's limits), `streams` is the reader's
// own order and `matched` is false. One stream or none is always matched.
inline AudioStreamOrder AudioStreamsInFileOrder(const std::wstring& path) {
    using namespace audio_track_order_detail;
    using Microsoft::WRL::ComPtr;
    AudioStreamOrder result;

    ComPtr<IMFSourceReader> reader;
    if (FAILED(MFCreateSourceReaderFromURL(path.c_str(), nullptr, &reader))) return result;
    for (DWORD index = 0;; ++index) {
        ComPtr<IMFMediaType> type;
        if (FAILED(reader->GetNativeMediaType(index, 0, &type))) break;
        GUID major{};
        if (SUCCEEDED(type->GetGUID(MF_MT_MAJOR_TYPE, &major)) && major == MFMediaType_Audio) result.streams.push_back(index);
    }
    if (result.streams.size() < 2) { result.matched = true; return result; }

    const std::vector<uint8_t> moov = ReadMoov(path);
    std::vector<Mp4AudioTrack> tracks;
    if (moov.empty() || !ParseMp4AudioTracks(moov.data(), moov.size(), result.streams.size(), tracks) ||
        tracks.size() != result.streams.size()) return result;

    // Each stream takes one of the tracks not placed yet; the last one left is
    // the last stream's without reading it.
    std::vector<bool> placed(tracks.size(), false);
    std::vector<int> streamOfTrack(tracks.size(), -1);
    for (size_t s = 0; s < result.streams.size(); ++s) {
        const int track = MatchStream(reader.Get(), result.streams[s], tracks, placed);
        if (track < 0) return result;
        placed[static_cast<size_t>(track)] = true;
        streamOfTrack[static_cast<size_t>(track)] = static_cast<int>(s);
    }
    std::vector<DWORD> ordered;
    for (int s : streamOfTrack) ordered.push_back(result.streams[static_cast<size_t>(s)]);
    result.streams = std::move(ordered);
    result.matched = true;
    return result;
}

// For readers that may fall back to the reader's order: says so on stderr,
// once per file and caller for the life of the process.
inline void LogUnmatchedTrackOrder(const std::wstring& path, const char* what) {
    static std::mutex mutex;
    static std::set<std::pair<std::string, std::wstring>> logged;
    std::lock_guard lock(mutex);
    if (!logged.insert({what, path}).second) return;
    std::fprintf(stderr, "flash: %s: could not tell this clip's audio tracks apart; using the reader's order, which may not be the file's: %ls\n",
                 what, path.c_str());
}

} // namespace flash
