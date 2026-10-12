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
// every sample, from the track's `stsz` table, against the sizes of the
// samples the reader hands back undecoded. Two tracks whose sizes agree from
// the first sample to the last are both encoded silence, and telling those
// apart does not matter.
#include <Windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

namespace flash {
namespace audio_track_order_detail {

inline uint32_t Be32(const std::vector<uint8_t>& data, size_t at) {
    return (static_cast<uint32_t>(data[at]) << 24) | (static_cast<uint32_t>(data[at + 1]) << 16) |
           (static_cast<uint32_t>(data[at + 2]) << 8) | static_cast<uint32_t>(data[at + 3]);
}

struct Box { uint32_t type = 0; size_t begin = 0, end = 0; };   // payload range

constexpr uint32_t Tag(char a, char b, char c, char d) {
    return (static_cast<uint32_t>(static_cast<uint8_t>(a)) << 24) | (static_cast<uint32_t>(static_cast<uint8_t>(b)) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(c)) << 8) | static_cast<uint32_t>(static_cast<uint8_t>(d));
}

// The boxes directly inside [begin, end). A box that does not fit ends the list.
inline std::vector<Box> Children(const std::vector<uint8_t>& data, size_t begin, size_t end) {
    std::vector<Box> boxes;
    size_t at = begin;
    while (at + 8 <= end) {
        uint64_t size = Be32(data, at);
        size_t header = 8;
        if (size == 1) {
            if (at + 16 > end) break;
            size = (static_cast<uint64_t>(Be32(data, at + 8)) << 32) | Be32(data, at + 12);
            header = 16;
        } else if (size == 0) {
            size = end - at;
        }
        if (size < header || size > end - at) break;
        boxes.push_back({Be32(data, at + 4), at + header, at + static_cast<size_t>(size)});
        at += static_cast<size_t>(size);
    }
    return boxes;
}

inline const Box* Find(const std::vector<Box>& boxes, uint32_t type) {
    for (const auto& box : boxes) if (box.type == type) return &box;
    return nullptr;
}

// Reads the `moov` box without loading the media data around it.
inline std::vector<uint8_t> ReadMoov(const std::wstring& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return {};
    file.seekg(0, std::ios::end);
    const uint64_t fileSize = static_cast<uint64_t>(file.tellg());
    uint64_t at = 0;
    while (at + 8 <= fileSize) {
        uint8_t head[16];
        file.seekg(static_cast<std::streamoff>(at));
        if (!file.read(reinterpret_cast<char*>(head), 8)) return {};
        uint64_t size = (static_cast<uint64_t>(head[0]) << 24) | (static_cast<uint64_t>(head[1]) << 16) |
                        (static_cast<uint64_t>(head[2]) << 8) | head[3];
        uint64_t header = 8;
        if (size == 1) {
            if (!file.read(reinterpret_cast<char*>(head + 8), 8)) return {};
            size = 0;
            for (int i = 8; i < 16; ++i) size = (size << 8) | head[i];
            header = 16;
        } else if (size == 0) {
            size = fileSize - at;
        }
        if (size < header || size > fileSize - at) return {};
        if (head[4] == 'm' && head[5] == 'o' && head[6] == 'o' && head[7] == 'v') {
            // A sample table is a few bytes per sample; this is far above any real clip.
            if (size - header > (256u << 20)) return {};
            std::vector<uint8_t> moov(static_cast<size_t>(size - header));
            if (!moov.empty() && !file.read(reinterpret_cast<char*>(moov.data()), static_cast<std::streamsize>(moov.size()))) return {};
            return moov;
        }
        at += size;
    }
    return {};
}

// One entry per audio track, in file order: the size of each of its samples.
// Empty when the file is not an MP4 whose sample tables can be read.
inline std::vector<std::vector<uint32_t>> AudioTrackSampleSizes(const std::wstring& path) {
    std::vector<std::vector<uint32_t>> tracks;
    const std::vector<uint8_t> moov = ReadMoov(path);
    if (moov.empty()) return {};
    for (const Box& trak : Children(moov, 0, moov.size())) {
        if (trak.type != Tag('t', 'r', 'a', 'k')) continue;
        const Box* mdia = Find(Children(moov, trak.begin, trak.end), Tag('m', 'd', 'i', 'a'));
        if (!mdia) continue;
        const auto media = Children(moov, mdia->begin, mdia->end);
        const Box* hdlr = Find(media, Tag('h', 'd', 'l', 'r'));
        if (!hdlr || hdlr->end - hdlr->begin < 12 || Be32(moov, hdlr->begin + 8) != Tag('s', 'o', 'u', 'n')) continue;
        const Box* minf = Find(media, Tag('m', 'i', 'n', 'f'));
        const Box* stbl = minf ? Find(Children(moov, minf->begin, minf->end), Tag('s', 't', 'b', 'l')) : nullptr;
        const Box* stsz = stbl ? Find(Children(moov, stbl->begin, stbl->end), Tag('s', 't', 's', 'z')) : nullptr;
        if (!stsz || stsz->end - stsz->begin < 12) return {};
        const uint32_t fixedSize = Be32(moov, stsz->begin + 4), count = Be32(moov, stsz->begin + 8);
        std::vector<uint32_t> sizes;
        if (fixedSize) sizes.assign(count, fixedSize);
        else {
            if ((stsz->end - stsz->begin - 12) / 4 < count) return {};
            sizes.reserve(count);
            for (uint32_t i = 0; i < count; ++i) sizes.push_back(Be32(moov, stsz->begin + 12 + static_cast<size_t>(i) * 4));
        }
        tracks.push_back(std::move(sizes));
    }
    return tracks;
}

} // namespace audio_track_order_detail

// The reader's audio stream numbers for `path`, ordered as the file orders its
// audio tracks. Stream numbers are the same in every source reader opened on
// the same file. Needs Media Foundation started on the calling thread.
//
// When the match cannot be made (not an MP4, a fragmented one, a track the
// reader hides), the reader's own order is returned unchanged and `matched`
// is false.
inline std::vector<DWORD> AudioStreamsInFileOrder(const std::wstring& path, bool* matched = nullptr) {
    using namespace audio_track_order_detail;
    using Microsoft::WRL::ComPtr;
    if (matched) *matched = false;

    ComPtr<IMFSourceReader> reader;
    if (FAILED(MFCreateSourceReaderFromURL(path.c_str(), nullptr, &reader))) return {};
    std::vector<DWORD> streams;
    for (DWORD index = 0;; ++index) {
        ComPtr<IMFMediaType> type;
        if (FAILED(reader->GetNativeMediaType(index, 0, &type))) break;
        GUID major{};
        if (SUCCEEDED(type->GetGUID(MF_MT_MAJOR_TYPE, &major)) && major == MFMediaType_Audio) streams.push_back(index);
    }
    if (streams.size() < 2) { if (matched) *matched = true; return streams; }

    const auto tracks = AudioTrackSampleSizes(path);
    if (tracks.size() != streams.size()) return streams;

    // For each stream, the track it is: read its samples undecoded and strike
    // out every track whose table disagrees, until one is left.
    std::vector<int> streamOfTrack(tracks.size(), -1);
    for (size_t s = 0; s < streams.size(); ++s) {
        if (FAILED(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE)) ||
            FAILED(reader->SetStreamSelection(streams[s], TRUE))) return streams;
        PROPVARIANT start; PropVariantInit(&start); start.vt = VT_I8; start.hVal.QuadPart = 0;
        const HRESULT seek = reader->SetCurrentPosition(GUID_NULL, start);
        PropVariantClear(&start);
        if (FAILED(seek)) return streams;

        std::vector<size_t> candidates;
        for (size_t t = 0; t < tracks.size(); ++t) candidates.push_back(t);
        size_t sampleIndex = 0;
        bool ended = false;
        while (candidates.size() > 1 && !ended) {
            DWORD actual = 0, flags = 0; LONGLONG time = 0; ComPtr<IMFSample> sample;
            if (FAILED(reader->ReadSample(streams[s], 0, &actual, &flags, &time, &sample)) ||
                (flags & MF_SOURCE_READERF_ERROR)) return streams;
            if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { ended = true; break; }
            if (!sample) continue;
            DWORD length = 0;
            if (FAILED(sample->GetTotalLength(&length))) return streams;
            candidates.erase(std::remove_if(candidates.begin(), candidates.end(), [&](size_t t) {
                return sampleIndex >= tracks[t].size() || tracks[t][sampleIndex] != length;
            }), candidates.end());
            ++sampleIndex;
        }
        // Read to the end with more than one left: those tracks are the same
        // size sample for sample. Only the ones of that exact length qualify.
        if (ended) candidates.erase(std::remove_if(candidates.begin(), candidates.end(),
            [&](size_t t) { return tracks[t].size() != sampleIndex; }), candidates.end());
        bool placed = false;
        for (size_t t : candidates) if (streamOfTrack[t] < 0) { streamOfTrack[t] = static_cast<int>(s); placed = true; break; }
        if (!placed) return streams;
    }

    std::vector<DWORD> ordered;
    for (int s : streamOfTrack) { if (s < 0) return streams; ordered.push_back(streams[static_cast<size_t>(s)]); }
    if (matched) *matched = true;
    return ordered;
}

} // namespace flash
