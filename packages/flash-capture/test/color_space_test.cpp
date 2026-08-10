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
}
