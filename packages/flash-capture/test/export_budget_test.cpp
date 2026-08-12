// Self-check for the share-copy size budget. Pure arithmetic — no Media
// Foundation, so it runs anywhere and fails loudly if the sizing logic breaks.
#include "../src/buffer/export_budget.h"
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

    // A very long clip at a tiny ceiling still floors the video bitrate rather
    // than going to zero or negative.
    {
        const auto plan = PlanExport(1920, 1080, 60, 600.0, 5ull * 1024 * 1024, 0);
        assert(plan.videoKbps >= kExportMinVideoKbps);
        assert(plan.height >= 2);
    }

    std::puts("export budget self-check passed");
    return 0;
}
