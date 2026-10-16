// Self-check for the MP4 track-table parser that tells a clip's audio tracks
// apart. Every fixture is built here from bytes. Pure logic, runs on every
// platform; the Media Foundation side of the match is covered by
// scripts/probes/track-order.js.
#include "../src/core/mp4_track_table.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace flash;
using Bytes = std::vector<uint8_t>;

static void Put32(Bytes& out, uint32_t value) {
    for (int shift = 24; shift >= 0; shift -= 8) out.push_back(static_cast<uint8_t>(value >> shift));
}
static Bytes Box(const char* type, const Bytes& payload) {
    Bytes out;
    Put32(out, static_cast<uint32_t>(payload.size() + 8));
    out.insert(out.end(), type, type + 4);
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
}
static Bytes Cat(std::initializer_list<Bytes> parts) {
    Bytes out;
    for (const auto& part : parts) out.insert(out.end(), part.begin(), part.end());
    return out;
}
static Bytes Hdlr(const char* handler) {
    Bytes payload(8, 0);                                   // version, flags, pre_defined
    payload.insert(payload.end(), handler, handler + 4);
    payload.resize(payload.size() + 12 + 1, 0);           // reserved, empty name
    return Box("hdlr", payload);
}
// A stsz listing every size, or a fixed size with `count` samples. `listed`
// is how many sizes are actually present, normally all of them.
static Bytes Stsz(uint32_t fixedSize, uint32_t count, const std::vector<uint32_t>& sizes) {
    Bytes payload(4, 0);
    Put32(payload, fixedSize);
    Put32(payload, count);
    for (uint32_t size : sizes) Put32(payload, size);
    return Box("stsz", payload);
}
static Bytes Trak(const char* handler, const Bytes& stsz) {
    const Bytes stbl = Box("stbl", Cat({Box("stsd", Bytes(8, 0)), stsz}));
    const Bytes minf = Box("minf", Cat({Box("smhd", Bytes(8, 0)), stbl}));
    return Box("trak", Cat({Box("tkhd", Bytes(84, 0)), Box("mdia", Cat({Box("mdhd", Bytes(24, 0)), Hdlr(handler), minf}))}));
}
static Bytes VideoTrak() { return Trak("vide", Stsz(0, 2, {900, 300})); }

static bool Parse(const Bytes& moov, size_t maxTracks, std::vector<Mp4AudioTrack>& tracks) {
    return ParseMp4AudioTracks(moov.data(), moov.size(), maxTracks, tracks);
}
static std::vector<uint8_t> MoovOf(const Bytes& file) {
    return ReadMp4Moov(file.size(), [&](uint64_t offset, uint8_t* buffer, size_t length) {
        if (offset > file.size() || length > file.size() - offset) return false;
        std::memcpy(buffer, file.data() + offset, length);
        return true;
    });
}

int main() {
    const Bytes mvhd = Box("mvhd", Bytes(100, 0));

    // A normal clip: video first, then three audio tracks, as Flash writes them.
    const Bytes normal = Cat({mvhd, VideoTrak(),
        Trak("soun", Stsz(0, 3, {10, 11, 12})), Trak("soun", Stsz(0, 3, {20, 21, 22})), Trak("soun", Stsz(0, 2, {30, 31}))});
    std::vector<Mp4AudioTrack> tracks;
    assert(Parse(normal, 8, tracks));
    assert(tracks.size() == 3);
    assert(tracks[0].count == 3 && tracks[0].SizeAt(2) == 12);
    assert(tracks[1].SizeAt(0) == 20);
    assert(tracks[2].count == 2 && tracks[2].SizeAt(1) == 31);
    assert(!(tracks[0] == tracks[1]));

    // The moov is found among top-level boxes, including after a 64-bit mdat
    // and when it is the last box with size 0 ("to the end of the file").
    {
        const Bytes ftyp = Box("ftyp", Bytes(8, 0));
        Bytes mdat64;
        Put32(mdat64, 1); mdat64.insert(mdat64.end(), {'m', 'd', 'a', 't'});
        Put32(mdat64, 0); Put32(mdat64, 16 + 5);
        mdat64.resize(mdat64.size() + 5, 0xAB);
        const Bytes moov = Box("moov", normal);
        assert(MoovOf(Cat({ftyp, mdat64, moov})) == normal);
        Bytes toEnd = moov;
        toEnd[0] = toEnd[1] = toEnd[2] = toEnd[3] = 0;
        assert(MoovOf(Cat({ftyp, mdat64, toEnd})) == normal);
        // A truncated top-level box, and a file with no moov at all.
        Bytes truncated = Cat({ftyp, moov});
        truncated.resize(truncated.size() - 4);
        assert(MoovOf(truncated).empty());
        assert(MoovOf(Cat({ftyp, mdat64})).empty());
        // A moov that claims more than the ceiling is not read.
        Bytes huge = ftyp;
        Put32(huge, 1); huge.insert(huge.end(), {'m', 'o', 'o', 'v'});
        Put32(huge, 0); Put32(huge, 0x7FFFFFFF);
        assert(MoovOf(huge).empty());
    }

    // Children: a truncated box, a box smaller than its header, size 0 and size 1.
    {
        std::vector<mp4_detail::Box> boxes;
        Bytes truncated = Box("free", Bytes(16, 0));
        truncated.resize(truncated.size() - 1);
        assert(!mp4_detail::Children(truncated.data(), 0, truncated.size(), boxes));
        Bytes tiny = {0, 0, 0, 4, 'f', 'r', 'e', 'e'};
        assert(!mp4_detail::Children(tiny.data(), 0, tiny.size(), boxes));
        Bytes tail = {0, 0, 0, 1};   // fewer than 8 bytes left over
        Bytes oneThenTail = Cat({Box("free", {}), tail});
        assert(!mp4_detail::Children(oneThenTail.data(), 0, oneThenTail.size(), boxes));
        Bytes toEnd = Cat({Box("free", {}), Bytes{0, 0, 0, 0, 's', 'k', 'i', 'p', 1, 2, 3}});
        assert(mp4_detail::Children(toEnd.data(), 0, toEnd.size(), boxes));
        assert(boxes.size() == 2 && boxes[1].end == toEnd.size() && boxes[1].end - boxes[1].begin == 3);
        Bytes wide = {0, 0, 0, 1, 'w', 'i', 'd', 'e', 0, 0, 0, 0, 0, 0, 0, 18, 7, 7};
        assert(mp4_detail::Children(wide.data(), 0, wide.size(), boxes));
        assert(boxes.size() == 1 && boxes[0].begin == 16 && boxes[0].end == 18);
        Bytes wideTooBig = wide;
        wideTooBig[11] = 1;   // 64-bit size far past the buffer
        assert(!mp4_detail::Children(wideTooBig.data(), 0, wideTooBig.size(), boxes));
        // Bounded output: more children than the ceiling is a refusal, not a
        // vector of a few hundred million entries.
        Bytes many;
        for (size_t i = 0; i <= kMp4MaxChildBoxes; ++i) { const Bytes empty = Box("free", {}); many.insert(many.end(), empty.begin(), empty.end()); }
        assert(!mp4_detail::Children(many.data(), 0, many.size(), boxes));
        assert(Parse(many, 8, tracks) == false && tracks.empty());
    }

    // An audio track with no stsz cannot be matched.
    {
        const Bytes stbl = Box("stbl", Box("stsd", Bytes(8, 0)));
        const Bytes noStsz = Box("trak", Box("mdia", Cat({Hdlr("soun"), Box("minf", stbl)})));
        assert(!Parse(Cat({mvhd, VideoTrak(), Trak("soun", Stsz(0, 1, {5})), noStsz}), 8, tracks));
        assert(tracks.empty());
    }

    // A fixed-size stsz is described, not materialised.
    {
        assert(Parse(Cat({mvhd, Trak("soun", Stsz(371, 1000, {})), Trak("soun", Stsz(0, 2, {371, 371}))}), 8, tracks));
        assert(tracks.size() == 2 && tracks[0].fixedSize == 371 && tracks[0].sizes.empty() && tracks[0].count == 1000);
        assert(tracks[0].SizeAt(999) == 371 && tracks[1].SizeAt(1) == 371);
    }

    // The I1 bounds: a fixed size with 0xFFFFFFFF samples is refused without
    // allocating; so is a listed count beyond the ceiling, and a count larger
    // than the table that follows it.
    {
        assert(!Parse(Cat({mvhd, Trak("soun", Stsz(371, 0xFFFFFFFFu, {}))}), 8, tracks) && tracks.empty());
        assert(!Parse(Cat({mvhd, Trak("soun", Stsz(371, kMp4MaxTrackSamples + 1, {}))}), 8, tracks));
        assert(Parse(Cat({mvhd, Trak("soun", Stsz(371, kMp4MaxTrackSamples, {}))}), 8, tracks));
        assert(!Parse(Cat({mvhd, Trak("soun", Stsz(0, 0xFFFFFFFFu, {1, 2, 3}))}), 8, tracks));
        assert(!Parse(Cat({mvhd, Trak("soun", Stsz(0, 4, {1, 2, 3}))}), 8, tracks));
    }

    // A fragmented MP4: its samples are in fragments and the tables are empty.
    {
        const Bytes mvex = Box("mvex", Box("trex", Bytes(24, 0)));
        assert(!Parse(Cat({mvhd, VideoTrak(), Trak("soun", Stsz(0, 0, {})), Trak("soun", Stsz(0, 0, {})), mvex}), 8, tracks));
        assert(tracks.empty());
        // Without mvex an empty track is just an empty track.
        assert(Parse(Cat({mvhd, Trak("soun", Stsz(0, 0, {}))}), 8, tracks) && tracks.size() == 1 && tracks[0].count == 0);
    }

    // More audio tracks than the reader has streams is a refusal as soon as
    // it is seen; fewer is reported as they are, for the caller to compare.
    {
        assert(!Parse(normal, 2, tracks) && tracks.empty());
        assert(Parse(normal, 3, tracks) && tracks.size() == 3);
        assert(Parse(normal, 5, tracks) && tracks.size() == 3);
        assert(Parse(Cat({mvhd, VideoTrak()}), 5, tracks) && tracks.empty());
    }

    // Identical silent tracks: equal sample-size sequences compare equal, by
    // listed sizes or by a fixed size, and differ from a track with sound.
    {
        const std::vector<uint32_t> silence(50, 6);
        std::vector<uint32_t> sound = silence;
        sound[37] = 210;
        assert(Parse(Cat({mvhd, VideoTrak(), Trak("soun", Stsz(0, 50, silence)), Trak("soun", Stsz(0, 50, sound)),
                          Trak("soun", Stsz(0, 50, silence)), Trak("soun", Stsz(6, 50, {}))}), 8, tracks));
        assert(tracks.size() == 4);
        assert(tracks[0] == tracks[2] && tracks[0] == tracks[3]);
        assert(!(tracks[0] == tracks[1]));
    }

    // A non-audio trak and a trak with no mdia are skipped, not fatal.
    {
        const Bytes bare = Box("trak", Box("tkhd", Bytes(84, 0)));
        assert(Parse(Cat({mvhd, bare, VideoTrak(), Trak("soun", Stsz(0, 1, {9}))}), 8, tracks) && tracks.size() == 1);
    }

    std::printf("mp4 track table self-check passed\n");
    return 0;
}
