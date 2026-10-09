// Self-check for the share-copy size budget. Pure arithmetic — no Media
// Foundation, so it runs anywhere and fails loudly if the sizing logic breaks.
#include "../src/core/export_budget.h"
#include <cassert>
#include <cstdio>

using namespace flash;

int main() {
    // A 30s 1080p60 clip squeezed into Discord's free 10MB limit must drop
    // resolution rather than starve 1080p into mush.
    {
        const auto plan = PlanExport(1920, 1080, 60, 30.0, 10ull * 1024 * 1024, 0);
        assert(plan.height <= 1080 && plan.height >= 360);
        assert(plan.width % 2 == 0 && plan.height % 2 == 0);
        const double budgetKbits = (10.0 * 1024 * 1024 * 8 * 0.95) / 1000.0 / 30.0;
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
        const auto floorBytes = static_cast<uint64_t>(std::ceil(428000.0 * 10 / 8 / 0.95));
        assert(PlanExport(1920, 1080, 60, 10, floorBytes - 1, 0).width == 0);
        assert(PlanExport(1920, 1080, 60, 10, floorBytes, 0).videoKbps >= kExportMinVideoKbps);
    }
    {
        const ExportPlan previous{1920, 1080, 2000, 128, 60};
        const auto retry = RetryExportPlan(previous, 1000, 2000);
        assert(retry.videoKbps == 920 && retry.height == 1080);
        const auto starved = RetryExportPlan(previous, 100, 2000);
        assert(starved.videoKbps == kExportMinVideoKbps);
        assert(starved.height == 720 && starved.width == 1280);
        assert(starved.audioKbps == previous.audioKbps && starved.fps == previous.fps);
        assert(RetryExportPlan(previous, 100, 0).width == 0);
        const ExportPlan smallest{640, 360, 300, 128, 30};
        assert(RetryExportPlan(smallest, 100, 200).height == 360);
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
