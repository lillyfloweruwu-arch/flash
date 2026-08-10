#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

namespace flash {

struct SmartRenderPlan {
    bool needsHeadEncode = false;
    int64_t headStartUs = 0;
    int64_t headEndUs = 0;
    int64_t copyStartUs = 0;
};

// keyframesUs must be sorted ascending. The returned plan re-encodes
// [headStartUs, headEndUs) and copies samples from copyStartUs onward.
inline SmartRenderPlan PlanSmartRender(const std::vector<int64_t>& keyframesUs,
                                       int64_t startUs, int64_t endUs) {
    SmartRenderPlan plan;
    if (endUs <= startUs) {
        plan.headStartUs = plan.headEndUs = plan.copyStartUs = startUs;
        return plan;
    }
    const bool onKeyframe = std::binary_search(keyframesUs.begin(), keyframesUs.end(), startUs);
    if (onKeyframe) {
        plan.copyStartUs = startUs;
        return plan;
    }
    const auto next = std::upper_bound(keyframesUs.begin(), keyframesUs.end(), startUs);
    const int64_t boundary = next == keyframesUs.end() ? endUs : (std::min)(*next, endUs);
    plan.needsHeadEncode = true;
    plan.headStartUs = startUs;
    plan.headEndUs = boundary;
    plan.copyStartUs = boundary;
    return plan;
}

} // namespace flash
