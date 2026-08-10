#include "../src/color_space.h"
#include <cassert>

int main() {
    // Limited range: white stops at 235, black sits on 16.
    assert(flash::Bt709Y(255, 255, 255) == 235);
    assert(flash::Bt709Y(0, 0, 0) == 16);

    // Grey must stay exactly neutral, or flat surfaces pick up a colour cast.
    assert(flash::Bt709U(128, 128, 128) == 128);
    assert(flash::Bt709V(128, 128, 128) == 128);

    // The BT.601 matrix this replaced put pure red at Y=82. Decoding that as
    // BT.709 is what oversaturated every clip; BT.709 puts red at Y=63.
    assert(flash::Bt709Y(255, 0, 0) == 63);
    assert(flash::Bt709V(255, 0, 0) == 240);
    assert(flash::Bt709U(0, 0, 255) == 240);

    // Saturation. 100 percent must be bit-exact, or every unmodified export
    // would drift.
    assert(flash::ApplySaturation(128, 100) == 128);
    assert(flash::ApplySaturation(200, 100) == 200);
    assert(flash::ApplySaturation(16, 100) == 16);

    // Zero collapses chroma to neutral grey; boosting clamps rather than
    // wrapping, which would turn a saturated red into cyan.
    assert(flash::ApplySaturation(200, 0) == 128);
    assert(flash::ApplySaturation(16, 0) == 128);
    assert(flash::ApplySaturation(250, 200) == 255);
    assert(flash::ApplySaturation(10, 200) == 0);

    // Half moves each sample halfway to neutral, and does so by the same amount
    // on both sides. Rounding with a plain "+ 50" gets 228 right and 28 wrong,
    // biasing the whole chroma plane one step up.
    assert(flash::ApplySaturation(228, 50) == 178);
    assert(flash::ApplySaturation(28, 50) == 78);

    // Neutral never drifts, at any setting.
    for (uint32_t percent = 0; percent <= 200; percent += 10)
        assert(flash::ApplySaturation(128, percent) == 128);

    // Symmetric about neutral wherever the 8-bit range allows it. Values that
    // clamp are skipped: there are 127 steps above neutral and 128 below.
    for (int delta = 1; delta <= 127; ++delta) {
        for (uint32_t percent : {0u, 25u, 50u, 75u, 150u, 200u}) {
            const int high = flash::ApplySaturation(static_cast<uint8_t>(128 + delta), percent);
            const int low = flash::ApplySaturation(static_cast<uint8_t>(128 - delta), percent);
            if (high == 255 || low == 0) continue;
            assert(high - 128 == 128 - low);
        }
    }
}
