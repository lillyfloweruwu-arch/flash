#pragma once
// What an MP4 says about its audio tracks: the byte size of every sample, per
// `soun` track, in file order. Platform code uses it to tell which of a media
// reader's streams is which track (see platform/windows/audio_track_order.h).
//
// The input is a file the user picked, so nothing here trusts it: every count
// read from it is checked against what the bytes can hold and against a fixed
// ceiling before anything is allocated, and anything over a limit means "cannot
// tell", never a crash.
#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace flash {

// Far beyond any clip Flash makes or exports (the exporter refuses more than
// 15 minutes; one AAC sample is 1024 frames, about 47 per second at 48 kHz, so
// 15 minutes is about 42,000) and still a small table: 2^20 samples is six
// hours at 48 kHz, and 4 MB when every size is listed.
inline constexpr uint32_t kMp4MaxTrackSamples = 1u << 20;
// A clip has a handful of tracks; a box with more children than this is not one.
inline constexpr size_t kMp4MaxChildBoxes = 4096;
// A sample table at the ceiling above, times a generous number of tracks.
inline constexpr uint64_t kMp4MaxMoovBytes = 64ull << 20;

struct Mp4AudioTrack {
    uint32_t count = 0;            // samples in the track
    uint32_t fixedSize = 0;        // non-zero: every sample is this size and `sizes` is empty
    std::vector<uint32_t> sizes;   // per sample, when they differ
    uint32_t SizeAt(uint32_t index) const { return fixedSize ? fixedSize : sizes[index]; }
    bool operator==(const Mp4AudioTrack& other) const {
        if (count != other.count) return false;
        for (uint32_t i = 0; i < count; ++i) if (SizeAt(i) != other.SizeAt(i)) return false;
        return true;
    }
};

namespace mp4_detail {

inline uint32_t Be32(const uint8_t* data) {
    return (static_cast<uint32_t>(data[0]) << 24) | (static_cast<uint32_t>(data[1]) << 16) |
           (static_cast<uint32_t>(data[2]) << 8) | static_cast<uint32_t>(data[3]);
}

constexpr uint32_t Tag(char a, char b, char c, char d) {
    return (static_cast<uint32_t>(static_cast<uint8_t>(a)) << 24) | (static_cast<uint32_t>(static_cast<uint8_t>(b)) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(c)) << 8) | static_cast<uint32_t>(static_cast<uint8_t>(d));
}

struct Box { uint32_t type = 0; size_t begin = 0, end = 0; };   // payload range within the buffer

// The boxes directly inside data[begin, end). A size of 0 runs to `end`, a size
// of 1 is followed by a 64-bit size. False when a box does not fit, is smaller
// than its own header, or there are more than kMp4MaxChildBoxes of them.
inline bool Children(const uint8_t* data, size_t begin, size_t end, std::vector<Box>& out) {
    out.clear();
    size_t at = begin;
    while (at < end) {
        if (end - at < 8) return false;
        uint64_t size = Be32(data + at);
        size_t header = 8;
        if (size == 1) {
            if (end - at < 16) return false;
            size = (static_cast<uint64_t>(Be32(data + at + 8)) << 32) | Be32(data + at + 12);
            header = 16;
        } else if (size == 0) {
            size = end - at;
        }
        if (size < header || size > end - at) return false;
        if (out.size() >= kMp4MaxChildBoxes) return false;
        out.push_back({Be32(data + at + 4), at + header, at + static_cast<size_t>(size)});
        at += static_cast<size_t>(size);
    }
    return true;
}

inline const Box* Find(const std::vector<Box>& boxes, uint32_t type) {
    for (const auto& box : boxes) if (box.type == type) return &box;
    return nullptr;
}

} // namespace mp4_detail

// Finds the top-level `moov` box of a file of `fileSize` bytes and returns its
// payload. `read(offset, buffer, length)` fills the buffer or returns false.
// Empty when there is no readable `moov` or it is larger than kMp4MaxMoovBytes.
inline std::vector<uint8_t> ReadMp4Moov(uint64_t fileSize,
                                        const std::function<bool(uint64_t, uint8_t*, size_t)>& read) {
    uint64_t at = 0;
    int boxes = 0;
    while (at + 8 <= fileSize && boxes++ < static_cast<int>(kMp4MaxChildBoxes)) {
        uint8_t head[16];
        if (!read(at, head, 8)) return {};
        uint64_t size = mp4_detail::Be32(head);
        uint64_t header = 8;
        if (size == 1) {
            if (at + 16 > fileSize || !read(at + 8, head + 8, 8)) return {};
            size = (static_cast<uint64_t>(mp4_detail::Be32(head + 8)) << 32) | mp4_detail::Be32(head + 12);
            header = 16;
        } else if (size == 0) {
            size = fileSize - at;
        }
        if (size < header || size > fileSize - at) return {};
        if (mp4_detail::Be32(head + 4) == mp4_detail::Tag('m', 'o', 'o', 'v')) {
            if (size - header > kMp4MaxMoovBytes) return {};
            std::vector<uint8_t> moov(static_cast<size_t>(size - header));
            if (!moov.empty() && !read(at + header, moov.data(), moov.size())) return {};
            return moov;
        }
        at += size;
    }
    return {};
}

// The audio tracks described by a `moov` payload, in file order. False, with
// `tracks` empty, when they cannot all be described: a box that does not
// parse, a `soun` track with no readable `stsz`, a sample count over
// kMp4MaxTrackSamples or more than its table holds, a fragmented file (its
// samples live in fragments, not in these tables), or more than `maxTracks`
// audio tracks.
inline bool ParseMp4AudioTracks(const uint8_t* moov, size_t size, size_t maxTracks, std::vector<Mp4AudioTrack>& tracks) {
    using namespace mp4_detail;
    tracks.clear();
    std::vector<Box> top, inTrak, inMdia, inMinf, inStbl;
    if (!Children(moov, 0, size, top)) return false;
    if (Find(top, Tag('m', 'v', 'e', 'x'))) return false;
    for (const Box& trak : top) {
        if (trak.type != Tag('t', 'r', 'a', 'k')) continue;
        if (!Children(moov, trak.begin, trak.end, inTrak)) { tracks.clear(); return false; }
        const Box* mdia = Find(inTrak, Tag('m', 'd', 'i', 'a'));
        if (!mdia) continue;
        if (!Children(moov, mdia->begin, mdia->end, inMdia)) { tracks.clear(); return false; }
        const Box* hdlr = Find(inMdia, Tag('h', 'd', 'l', 'r'));
        // hdlr: version and flags (4), pre_defined (4), handler_type (4).
        if (!hdlr || hdlr->end - hdlr->begin < 12 || Be32(moov + hdlr->begin + 8) != Tag('s', 'o', 'u', 'n')) continue;
        if (tracks.size() >= maxTracks) { tracks.clear(); return false; }
        const Box* minf = Find(inMdia, Tag('m', 'i', 'n', 'f'));
        if (!minf || !Children(moov, minf->begin, minf->end, inMinf)) { tracks.clear(); return false; }
        const Box* stbl = Find(inMinf, Tag('s', 't', 'b', 'l'));
        if (!stbl || !Children(moov, stbl->begin, stbl->end, inStbl)) { tracks.clear(); return false; }
        const Box* stsz = Find(inStbl, Tag('s', 't', 's', 'z'));
        // stsz: version and flags (4), sample_size (4), sample_count (4), then sizes.
        if (!stsz || stsz->end - stsz->begin < 12) { tracks.clear(); return false; }
        Mp4AudioTrack track;
        track.fixedSize = Be32(moov + stsz->begin + 4);
        track.count = Be32(moov + stsz->begin + 8);
        if (track.count > kMp4MaxTrackSamples) { tracks.clear(); return false; }
        if (!track.fixedSize) {
            if ((stsz->end - stsz->begin - 12) / 4 < track.count) { tracks.clear(); return false; }
            track.sizes.reserve(track.count);
            for (uint32_t i = 0; i < track.count; ++i) track.sizes.push_back(Be32(moov + stsz->begin + 12 + static_cast<size_t>(i) * 4));
        }
        tracks.push_back(std::move(track));
    }
    return true;
}

} // namespace flash
