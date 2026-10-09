#include "../src/core/quality.h"
#include <cassert>
int main() {
    assert(flash::ComputeEvenWidth(1920, 1080, 1080) == 1920);
    assert(flash::ComputeEvenWidth(2560, 1440, 1080) == 1920);
    assert((flash::ComputeEvenWidth(3440, 1440, 1080) & 1) == 0);
    assert(flash::ComputeEvenWidth(0, 1080, 1080) == 0);
}
