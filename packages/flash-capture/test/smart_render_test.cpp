#include "../src/buffer/smart_render.h"
#include <cassert>

int main() {
    // Keyframes every two seconds, matching a GOP of fps * 2.
    const std::vector<int64_t> keys{0, 2000000, 4000000, 6000000, 8000000};

    // An in-point already on a keyframe needs no encode at all: the whole
    // save stays a pure remux.
    auto onKey = flash::PlanSmartRender(keys, 4000000, 7000000);
    assert(!onKey.needsHeadEncode);
    assert(onKey.copyStartUs == 4000000);

    // An in-point mid-GOP re-encodes from the in-point to the next keyframe,
    // then copies from that keyframe on.
    auto midGop = flash::PlanSmartRender(keys, 5000000, 7000000);
    assert(midGop.needsHeadEncode);
    assert(midGop.headStartUs == 5000000);
    assert(midGop.headEndUs == 6000000);
    assert(midGop.copyStartUs == 6000000);

    // When no keyframe follows the in-point, the head runs to the out-point
    // and nothing is copied.
    auto noFollowing = flash::PlanSmartRender(keys, 8500000, 9000000);
    assert(noFollowing.needsHeadEncode);
    assert(noFollowing.headStartUs == 8500000);
    assert(noFollowing.headEndUs == 9000000);
    assert(noFollowing.copyStartUs == 9000000);

    // The next keyframe past the out-point must not extend the head beyond it.
    auto shortRange = flash::PlanSmartRender(keys, 3000000, 3500000);
    assert(shortRange.needsHeadEncode);
    assert(shortRange.headEndUs == 3500000);
    assert(shortRange.copyStartUs == 3500000);

    // No keyframe list at all: encode the whole range rather than emit a
    // plan that copies undecodable bytes.
    auto empty = flash::PlanSmartRender({}, 1000000, 2000000);
    assert(empty.needsHeadEncode);
    assert(empty.headStartUs == 1000000);
    assert(empty.headEndUs == 2000000);

    // An inverted range yields an empty plan, never a negative span.
    auto inverted = flash::PlanSmartRender(keys, 5000000, 4000000);
    assert(!inverted.needsHeadEncode);
    assert(inverted.headStartUs == inverted.headEndUs);
}
