#pragma once

#include <algorithm>
#include <cstdint>
#include <cmath>
#include <cstring>

namespace flash {

// Pure arithmetic for sizing a share copy, kept free of Media Foundation and
// libav so it can be unit-tested on its own and shared by both platforms.

enum class ExportCodec { H264, Hevc, Av1 };

inline const char* ExportCodecName(ExportCodec codec) {
    switch (codec) {
        case ExportCodec::Av1: return "av1";
        case ExportCodec::Hevc: return "hevc";
        default: return "h264";
    }
}

inline bool ParseExportCodec(const char* text, ExportCodec& out) {
    if (!text) return false;
    for (ExportCodec codec : {ExportCodec::H264, ExportCodec::Hevc, ExportCodec::Av1})
        if (std::strcmp(text, ExportCodecName(codec)) == 0) { out = codec; return true; }
    return false;
}

// Bits a frame can afford at a given resolution before it stops being watchable.
// Below roughly 0.05 bits per pixel per frame H.264 turns to mush; the newer
// codecs hold up at about two thirds of that, which is the whole reason a 10MB
// copy can stay at 1080p under them.
inline double MinBitsPerPixel(ExportCodec codec) {
    switch (codec) {
        case ExportCodec::Av1: return 0.03;
        case ExportCodec::Hevc: return 0.033;
        default: return 0.05;
    }
}

struct ExportPlan {
    uint32_t width = 0, height = 0;
    uint32_t videoKbps = 0, audioKbps = 0;
    uint32_t fps = 0;
    ExportCodec codec = ExportCodec::H264;
    // The source's own bitrate when a real size limit applies; 0 means no cap
    // beyond kExportMaxVideoKbps. A copy never needs more bits than its source.
    uint32_t maxVideoKbps = 0;
};

constexpr uint32_t kExportAudioKbps = 128;
constexpr uint32_t kExportMinVideoKbps = 300;

// The editor's full-quality save asks for a budget of Number.MAX_SAFE_INTEGER,
// meaning "do not downscale for size". Unclamped, that came out as a bitrate of
// around 1.7e13 kbps, which does not fit the uint32 it is stored in, and the
// encoder answered MF_E_INVALIDMEDIATYPE — so every re-encoding save from the
// editor failed. This is the same ceiling setQuality already enforces on the
// recording path, and it is far above any real 4K bitrate.
constexpr uint32_t kExportMaxVideoKbps = 200000;

// A share copy aims at 94% of its limit and is encoded again if it lands under
// 88%: the limit is a hard ceiling, but a copy far below it threw quality away.
constexpr double kExportFill = 0.94;
constexpr double kExportFloor = 0.88;
// Budgets at or above this are "no size limit" (the editor's save), and are
// never encoded twice to chase a size.
constexpr uint64_t kExportUnlimitedBytes = 1ull << 40;

inline double BitsPerPixelPerFrame(uint32_t width, uint32_t height, uint32_t fps, uint32_t kbps) {
    const double pixels = static_cast<double>(width) * height * (fps ? fps : 1);
    return pixels > 0.0 ? (kbps * 1000.0) / pixels : 0.0;
}

// Chooses the largest standard height that both fits under the caller's ceiling
// and still earns its bitrate. Width follows the source aspect, rounded even
// because every codec here requires it.
inline ExportPlan PlanExport(uint32_t sourceWidth, uint32_t sourceHeight, uint32_t fps,
                             double durationSeconds, uint64_t maxBytes, uint32_t maxHeight,
                             ExportCodec codec = ExportCodec::H264, uint32_t maxFps = 0,
                             uint32_t sourceKbps = 0) {
    ExportPlan plan;
    plan.audioKbps = kExportAudioKbps;
    plan.codec = codec;
    if (!sourceWidth || !sourceHeight || !std::isfinite(durationSeconds) || durationSeconds <= 0.0 || !maxBytes) return plan;

    const double totalKbits = (static_cast<double>(maxBytes) * 8.0 * kExportFill) / 1000.0;
    // Even a sub-frame range needs one frame. Refuse budgets below the minimum
    // video/audio rates instead of encoding a file that cannot possibly fit.
    const double shortestOutput = (std::max)(durationSeconds, 1.0 / (fps ? fps : 30));
    double videoKbps = totalKbits / shortestOutput - plan.audioKbps;
    if (videoKbps < kExportMinVideoKbps) return plan;
    if (videoKbps > kExportMaxVideoKbps) videoKbps = kExportMaxVideoKbps;
    if (sourceKbps >= kExportMinVideoKbps) {
        plan.maxVideoKbps = (std::min)(sourceKbps, kExportMaxVideoKbps);
        if (videoKbps > plan.maxVideoKbps) videoKbps = plan.maxVideoKbps;
    }

    const uint32_t ceiling = maxHeight ? (std::min)(maxHeight, sourceHeight) : sourceHeight;
    const uint32_t ladder[] = {2160, 1440, 1080, 720, 480, 360};
    const double floor = MinBitsPerPixel(codec);
    uint32_t height = 0;

    // The source rate, lowered to the caller's cap, then 30. A share copy at
    // 720p30 beats 480p60: halving the frame rate doubles the bits each frame
    // can have, and legible HUD text matters more than smoothness in a clip
    // someone watches once in a chat window. A rate is never raised.
    const uint32_t sourceFps = fps ? fps : 30;
    const uint32_t first = maxFps ? (std::min)(sourceFps, maxFps) : sourceFps;
    const uint32_t rates[] = {first, (std::min)(first, 30u)};
    plan.fps = first;
    for (uint32_t rate : rates) {
        height = 0;
        for (uint32_t candidate : ladder) {
            if (candidate > ceiling) continue;
            const uint32_t width = static_cast<uint32_t>(
                (static_cast<uint64_t>(sourceWidth) * candidate + sourceHeight / 2) / sourceHeight) & ~1u;
            if (BitsPerPixelPerFrame(width, candidate, rate, static_cast<uint32_t>(videoKbps)) >= floor) {
                height = candidate;
                plan.width = width ? width : 2;
                plan.fps = rate;
                break;
            }
        }
        // Accept the first rate that keeps at least 720p; otherwise try the lower one.
        if (height >= 720 || rate == rates[1]) break;
    }
    if (!height) {   // even the smallest rung is starved; take it anyway
        height = (std::min)(ceiling, 360u);
        plan.width = static_cast<uint32_t>(
            (static_cast<uint64_t>(sourceWidth) * height + sourceHeight / 2) / sourceHeight) & ~1u;
        if (!plan.width) plan.width = 2;
    }
    plan.height = height & ~1u;
    if (!plan.height) plan.height = 2;
    plan.videoKbps = static_cast<uint32_t>(videoKbps);
    return plan;
}

// Whether an encode at `plan` that came out at `actual` bytes should be tried
// again: always when it is over the limit, and when it is well under one that
// still has bitrate left to give.
inline bool ExportNeedsRetry(const ExportPlan& plan, uint64_t budget, uint64_t actual) {
    if (actual > budget) return true;
    if (budget >= kExportUnlimitedBytes) return false;
    const uint32_t ceiling = plan.maxVideoKbps ? plan.maxVideoKbps : kExportMaxVideoKbps;
    return static_cast<double>(actual) < static_cast<double>(budget) * kExportFloor && plan.videoKbps < ceiling;
}

// Scales the video bitrate so the next attempt lands on 94% of the budget, in
// either direction. Scaling video alone moves the whole file by slightly less
// than the ratio, because audio stays put — which errs toward the safe side
// both ways. Drops a resolution rung only when the bitrate would starve.
inline ExportPlan RetryExportPlan(const ExportPlan& previous, uint64_t budget, uint64_t actual) {
    ExportPlan plan = previous;
    if (!actual || !budget) return {};
    const double bitrate = previous.videoKbps * (static_cast<double>(budget) * kExportFill / actual);
    if (bitrate < kExportMinVideoKbps) {
        for (uint32_t height : {2160u, 1440u, 1080u, 720u, 480u, 360u}) {
            if (height >= previous.height) continue;
            plan.height = height;
            plan.width = (std::max)(2u, static_cast<uint32_t>(
                static_cast<uint64_t>(previous.width) * height / previous.height) & ~1u);
            break;
        }
    }
    const double ceiling = previous.maxVideoKbps ? previous.maxVideoKbps : kExportMaxVideoKbps;
    plan.videoKbps = static_cast<uint32_t>((std::max)(static_cast<double>(kExportMinVideoKbps),
        (std::min)(bitrate, ceiling)));
    return plan;
}

// Picks frames for a constant-rate output from a source that may be faster and
// irregular. Each source frame belongs to the slot nearest its timestamp; the
// first frame to reach a slot takes it and later ones are dropped. Nearest, not
// floor, because timestamps are truncated: a 60 fps source's second frame sits
// at 16666 us, a hair short of slot 1.
struct FrameGrid {
    uint32_t fps = 60;
    int64_t next = 0;
    // Returns the output slot for a frame `timeUs` after the export start, or
    // -1 to drop it. The caller stamps the frame at slot / fps.
    int64_t Take(int64_t timeUs) {
        if (timeUs < 0 || !fps) return -1;
        const int64_t slot = (timeUs * fps + 500000) / 1000000;
        if (slot < next) return -1;
        next = slot + 1;
        return slot;
    }
};

} // namespace flash
