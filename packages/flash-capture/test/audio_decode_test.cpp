#include "../src/buffer/audio_decode.h"
#include <cassert>
#include <cmath>

static bool Near(float a, float b) { return std::fabs(a - b) < 1e-5f; }

int main() {
    // Downmix averages the channels rather than summing them, so a mono
    // preview of a stereo track does not clip.
    const float stereo[2] = {0.5f, -0.5f};
    assert(Near(flash::DownmixToMono(stereo, 2), 0.0f));
    const float loud[2] = {1.0f, 1.0f};
    assert(Near(flash::DownmixToMono(loud, 2), 1.0f));
    const float mono[1] = {0.25f};
    assert(Near(flash::DownmixToMono(mono, 1), 0.25f));

    // Halving the rate halves the sample count and keeps the endpoints.
    std::vector<float> source{0.0f, 1.0f, 0.0f, -1.0f};
    std::vector<float> out;
    flash::ResampleLinear(source, 48000, 24000, out);
    assert(out.size() == 2);
    assert(Near(out[0], 0.0f));

    // Same rate in and out is a copy, not a rebuild.
    flash::ResampleLinear(source, 48000, 48000, out);
    assert(out.size() == source.size());
    assert(Near(out[3], -1.0f));

    // Interpolation lands between neighbours, never outside them.
    std::vector<float> ramp{0.0f, 1.0f};
    flash::ResampleLinear(ramp, 2, 4, out);
    for (float v : out) assert(v >= 0.0f && v <= 1.0f);

    // Degenerate input must not divide by zero or read off the end.
    std::vector<float> empty;
    flash::ResampleLinear(empty, 48000, 22050, out);
    assert(out.empty());
    flash::ResampleLinear(source, 0, 22050, out);
    assert(out.empty());
}
