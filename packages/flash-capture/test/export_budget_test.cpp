// Self-check for the share-copy size budget. Pure arithmetic — no Media
// Foundation, so it runs anywhere and fails loudly if the sizing logic breaks.
#include "../src/core/export_budget.h"
#include <cassert>
#include <cstdio>
#include <string>

using namespace flash;

int main() {
    // A 30s 1080p60 clip squeezed into Discord's free 10MB limit must drop
    // resolution rather than starve 1080p into mush.
    {
        const auto plan = PlanExport(1920, 1080, 60, 30.0, 10ull * 1024 * 1024, 0);
        assert(plan.height <= 1080 && plan.height >= 360);
        assert(plan.width % 2 == 0 && plan.height % 2 == 0);
        const double budgetKbits = (10.0 * 1024 * 1024 * 8 * kExportFill) / 1000.0 / 30.0;
        assert(plan.videoKbps + plan.audioKbps <= budgetKbits + 1.0);
        // The quality floor applies at the output rate chosen by the plan, which
        // may be half the source rate. Only the documented smallest-rung fallback
        // below is allowed to miss it when no resolution/rate pair can earn 0.05.
        assert(plan.fps == 30);
        assert(BitsPerPixelPerFrame(plan.width, plan.height, plan.fps, plan.videoKbps) >= 0.05);
    }

    // With 500MB to play with, the source resolution should survive untouched.
    {
        const auto plan = PlanExport(1920, 1080, 60, 30.0, 500ull * 1024 * 1024, 0);
        assert(plan.height == 1080 && plan.width == 1920);
    }

    // An explicit ceiling wins even when the budget could afford more.
    {
        const auto plan = PlanExport(1920, 1080, 60, 10.0, 500ull * 1024 * 1024, 720);
        assert(plan.height == 720 && plan.width == 1280);
    }

    // Aspect ratio is preserved and kept even for an ultrawide source.
    {
        const auto plan = PlanExport(2560, 1080, 60, 30.0, 50ull * 1024 * 1024, 0);
        assert(plan.width % 2 == 0);
        const double sourceAspect = 2560.0 / 1080.0;
        const double planAspect = static_cast<double>(plan.width) / plan.height;
        assert(planAspect > sourceAspect - 0.05 && planAspect < sourceAspect + 0.05);
    }

    // Degenerate input must not divide by zero or return a zero size.
    {
        const auto plan = PlanExport(0, 0, 0, 0.0, 0, 0);
        assert(plan.width == 0 && plan.height == 0);
    }

    // A budget below the minimum rates cannot be satisfied even at the smallest rung.
    {
        const auto plan = PlanExport(1920, 1080, 60, 600.0, 5ull * 1024 * 1024, 0);
        assert(plan.width == 0 && plan.height == 0);
        assert(PlanExport(1920, 1080, 60, 0.00001, 1, 0).width == 0);
        const auto floorBytes = static_cast<uint64_t>(std::ceil(428000.0 * 10 / 8 / kExportFill));
        assert(PlanExport(1920, 1080, 60, 10, floorBytes - 1, 0).width == 0);
        assert(PlanExport(1920, 1080, 60, 10, floorBytes, 0).videoKbps >= kExportMinVideoKbps);
    }
    {
        const ExportPlan previous{1920, 1080, 2000, 128, 60};
        // Over the limit: scale toward 94% of it.
        const auto retry = RetryExportPlan(previous, 1000, 2000);
        assert(retry.videoKbps == 940 && retry.height == 1080);
        const auto starved = RetryExportPlan(previous, 100, 2000);
        assert(starved.videoKbps == kExportMinVideoKbps);
        assert(starved.height == 720 && starved.width == 1280);
        assert(starved.audioKbps == previous.audioKbps && starved.fps == previous.fps);
        assert(RetryExportPlan(previous, 100, 0).width == 0);
        const ExportPlan smallest{640, 360, 300, 128, 30};
        assert(RetryExportPlan(smallest, 100, 200).height == 360);
        // Under the limit: scale up toward 94%, never past the source bitrate.
        assert(RetryExportPlan(previous, 10000, 7000).videoKbps == 2685);
        ExportPlan capped = previous;
        capped.maxVideoKbps = 2500;
        assert(RetryExportPlan(capped, 10000, 7000).videoKbps == 2500);
        assert(RetryExportPlan(capped, 10000, 7000).codec == previous.codec);
    }

    // When to encode again.
    {
        ExportPlan plan{1920, 1080, 2000, 128, 60};
        assert(ExportNeedsRetry(plan, 1000, 1001));            // over the limit
        assert(!ExportNeedsRetry(plan, 1000, 1000));           // exactly at it
        assert(!ExportNeedsRetry(plan, 1000, 880));            // inside the window
        assert(ExportNeedsRetry(plan, 1000, 879));             // wasted quality
        // A short clip already at the source bitrate is allowed to be small.
        plan.maxVideoKbps = 2000;
        assert(!ExportNeedsRetry(plan, 1000, 100));
        // The editor's unlimited budget never chases a size.
        ExportPlan editor{1920, 1080, 20000, 128, 141};
        assert(!ExportNeedsRetry(editor, 9007199254740991ull, 5000000));
    }

    // Codec decides how much resolution a bitrate can carry. The reference clip:
    // 1080p at about 141 fps, 14.3 s, Discord's 10 MiB.
    {
        const uint64_t limit = 10ull * 1024 * 1024;
        const auto av1 = PlanExport(1920, 1080, 141, 14.3, limit, 0, ExportCodec::Av1, 60, 27000);
        assert(av1.height == 1080 && av1.fps == 60 && av1.codec == ExportCodec::Av1);
        const auto hevc = PlanExport(1920, 1080, 141, 14.3, limit, 0, ExportCodec::Hevc, 60, 27000);
        assert(hevc.height == 1080 && hevc.fps == 60);
        const auto h264 = PlanExport(1920, 1080, 141, 14.3, limit, 0, ExportCodec::H264, 60, 27000);
        assert(h264.height == 720 && h264.width == 1280 && h264.fps == 60);
    }

    // The cap only lowers a frame rate. No cap leaves it alone.
    {
        assert(PlanExport(1920, 1080, 141, 14.3, 500ull * 1024 * 1024, 0, ExportCodec::H264, 0, 0).fps == 141);
        assert(PlanExport(1920, 1080, 30, 14.3, 500ull * 1024 * 1024, 0, ExportCodec::H264, 60, 0).fps == 30);
        assert(PlanExport(1920, 1080, 24, 14.3, 500ull * 1024 * 1024, 0, ExportCodec::H264, 60, 0).fps == 24);
    }

    // A copy never gets more bits than the clip it came from.
    {
        const auto plan = PlanExport(1920, 1080, 60, 4.0, 10ull * 1024 * 1024, 0, ExportCodec::H264, 60, 8000);
        assert(plan.videoKbps == 8000 && plan.maxVideoKbps == 8000);
    }

    // Codec names round-trip, and junk is refused.
    {
        ExportCodec codec = ExportCodec::H264;
        assert(ParseExportCodec("av1", codec) && codec == ExportCodec::Av1);
        assert(ParseExportCodec("hevc", codec) && codec == ExportCodec::Hevc);
        assert(ParseExportCodec("h264", codec) && codec == ExportCodec::H264);
        assert(!ParseExportCodec("vp9", codec) && !ParseExportCodec(nullptr, codec));
        assert(std::string(ExportCodecName(ExportCodec::Av1)) == "av1");
    }

    // The frame grid: a 141 fps source becomes an even 60 fps with no slot
    // repeated and none out of order.
    {
        FrameGrid grid{60};
        int64_t last = -1;
        int taken = 0;
        for (int i = 0; i < 141; ++i) {
            const int64_t slot = grid.Take(static_cast<int64_t>(i) * 1000000 / 141);
            if (slot < 0) continue;
            assert(slot > last);
            last = slot;
            ++taken;
        }
        assert(taken >= 59 && taken <= 61);
    }
    // A source already at the grid rate keeps every frame, despite its
    // timestamps being truncated to whole microseconds.
    {
        FrameGrid grid{60};
        for (int i = 0; i < 120; ++i) assert(grid.Take(static_cast<int64_t>(i) * 1000000 / 60) == i);
    }
    // A hitch: a repeated timestamp is dropped, and a jump skips slots instead
    // of bunching frames up behind it.
    {
        FrameGrid grid{60};
        assert(grid.Take(0) == 0);
        assert(grid.Take(0) == -1);
        assert(grid.Take(100000) == 6);
        assert(grid.Take(90000) == -1);
        assert(grid.Take(-5) == -1);
    }

    // "Do not downscale for size" is spelled Number.MAX_SAFE_INTEGER by the
    // editor's full-quality save. Unclamped that produced a bitrate of about
    // 1.7e13 kbps, which does not fit the uint32 it is stored in, so the encoder
    // rejected the media type and every re-encoding save from the editor failed.
    {
        const auto plan = PlanExport(1920, 1080, 60, 4.0, 9007199254740991ull, 0);
        assert(plan.height == 1080 && plan.width == 1920);
        assert(plan.videoKbps == kExportMaxVideoKbps);
        assert(plan.videoKbps <= kExportMaxVideoKbps && plan.videoKbps >= kExportMinVideoKbps);
    }

    // The clamp must not disturb a budget that was already sane.
    {
        const auto plan = PlanExport(1920, 1080, 60, 30.0, 100ull * 1024 * 1024, 0);
        assert(plan.videoKbps < kExportMaxVideoKbps);
        assert(plan.videoKbps > kExportMinVideoKbps);
    }

    std::puts("export budget self-check passed");
    return 0;
}
