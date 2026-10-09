#pragma once

#include <algorithm>
#include <cstdint>
#include <cmath>

namespace flash {

// Pure arithmetic for sizing a share copy, kept free of Media Foundation so it
// can be unit-tested on its own.

struct ExportPlan {
    uint32_t width = 0, height = 0;
    uint32_t videoKbps = 0, audioKbps = 0;
    uint32_t fps = 0;
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

// Bits a frame can afford at a given resolution before it stops being watchable.
// Below roughly 0.05 bits per pixel per frame H.264 turns to mush, so the plan
// drops resolution rather than starving a larger one.
inline double BitsPerPixelPerFrame(uint32_t width, uint32_t height, uint32_t fps, uint32_t kbps) {
    const double pixels = static_cast<double>(width) * height * (fps ? fps : 1);
    return pixels > 0.0 ? (kbps * 1000.0) / pixels : 0.0;
}

// Chooses the largest standard height that both fits under the caller's ceiling
// and still earns its bitrate. Width follows the source aspect, rounded even
// because H.264 requires it.
inline ExportPlan PlanExport(uint32_t sourceWidth, uint32_t sourceHeight, uint32_t fps,
                             double durationSeconds, uint64_t maxBytes, uint32_t maxHeight) {
    ExportPlan plan;
    plan.audioKbps = kExportAudioKbps;
    if (!sourceWidth || !sourceHeight || !std::isfinite(durationSeconds) || durationSeconds <= 0.0 || !maxBytes) return plan;

    // Leave headroom for container overhead: the ceiling is a hard limit, and an
    // export that lands one byte over is a failed export.
    const double totalKbits = (static_cast<double>(maxBytes) * 8.0 * 0.95) / 1000.0;
    // Even a sub-frame range needs one frame. Refuse budgets below the minimum
    // video/audio rates instead of encoding a file that cannot possibly fit.
    const double shortestOutput = (std::max)(durationSeconds, 1.0 / (fps ? fps : 30));
    double videoKbps = totalKbits / shortestOutput - plan.audioKbps;
    if (videoKbps < kExportMinVideoKbps) return plan;
    if (videoKbps > kExportMaxVideoKbps) videoKbps = kExportMaxVideoKbps;

    const uint32_t ceiling = maxHeight ? (std::min)(maxHeight, sourceHeight) : sourceHeight;
    const uint32_t ladder[] = {2160, 1440, 1080, 720, 480, 360};
    uint32_t height = 0;
    plan.fps = fps ? fps : 30;

    // Try the full frame rate first, then half it. For a share copy 720p30 beats
    // 480p60: halving the frame rate doubles the bits each frame can have, and
    // legible HUD text matters more than smoothness in a clip someone watches
    // once in a chat window. Only drop resolution once both rates have failed.
    const uint32_t rates[] = {plan.fps, (std::max)(24u, plan.fps / 2)};
    for (uint32_t rate : rates) {
        for (uint32_t candidate : ladder) {
            if (candidate > ceiling) continue;
            const uint32_t width = static_cast<uint32_t>(
                (static_cast<uint64_t>(sourceWidth) * candidate + sourceHeight / 2) / sourceHeight) & ~1u;
            if (BitsPerPixelPerFrame(width, candidate, rate, static_cast<uint32_t>(videoKbps)) >= 0.05) {
                height = candidate;
                plan.width = width ? width : 2;
                plan.fps = rate;
                break;
            }
        }
        // Accept the first rate that keeps at least 720p; otherwise try halving.
        if (height >= 720) break;
        if (rate != rates[0]) break;
        height = 0;
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

inline ExportPlan RetryExportPlan(const ExportPlan& previous, uint64_t budget, uint64_t actual) {
    ExportPlan plan = previous;
    if (!actual || !budget) return {};
    const double bitrate = previous.videoKbps * (static_cast<double>(budget) / actual) * 0.92;
    if (bitrate < kExportMinVideoKbps) {
        for (uint32_t height : {2160u, 1440u, 1080u, 720u, 480u, 360u}) {
            if (height >= previous.height) continue;
            plan.height = height;
            plan.width = (std::max)(2u, static_cast<uint32_t>(
                static_cast<uint64_t>(previous.width) * height / previous.height) & ~1u);
            break;
        }
    }
    plan.videoKbps = static_cast<uint32_t>((std::max)(static_cast<double>(kExportMinVideoKbps),
        (std::min)(bitrate, static_cast<double>(kExportMaxVideoKbps))));
    return plan;
}

} // namespace flash
