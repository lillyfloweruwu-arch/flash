#pragma once

#include <algorithm>
#include <cstdint>


// Flash records BT.709 with limited (16-235) range, and tags every media type
// that carries the pixels so the file says so too.
//
// Both halves matter. Players, Discord and Chromium assume BT.709 limited for
// any untagged H.264 at 720p or above, so converting with the BT.601 matrix and
// tagging nothing means the decoder applies the wrong matrix on the way out and
// the clip comes back oversaturated — reds and greens worst.

namespace flash {

// BT.709 limited-range coefficients in Q8. Luma sums to 220 so white lands on
// 235; each chroma row sums to 0 so grey stays exactly on 128.
inline constexpr int kBt709Y[3] = {47, 157, 16};      // R, G, B
inline constexpr int kBt709U[3] = {-26, -86, 112};
inline constexpr int kBt709V[3] = {112, -102, -10};

// Unclamped on purpose: callers that average a 2x2 chroma block clamp once at
// the end rather than per sample.
inline int Bt709Y(int r, int g, int b) {
    return ((kBt709Y[0] * r + kBt709Y[1] * g + kBt709Y[2] * b + 128) >> 8) + 16;
}
inline int Bt709U(int r, int g, int b) {
    return ((kBt709U[0] * r + kBt709U[1] * g + kBt709U[2] * b + 128) >> 8) + 128;
}
inline int Bt709V(int r, int g, int b) {
    return ((kBt709V[0] * r + kBt709V[1] * g + kBt709V[2] * b + 128) >> 8) + 128;
}

// Saturation is a scale of each chroma sample about neutral, so it needs no
// colour-space round trip and 100 percent is exactly the identity. Luma is
// untouched: this changes how vivid the picture is and nothing else.
inline uint8_t ApplySaturation(uint8_t chroma, uint32_t percent) {
    if (percent == 100) return chroma;
    const int delta = static_cast<int>(chroma) - 128;
    // Round half away from zero. A plain "+ 50" rounds correctly only above
    // neutral; below it, integer division truncates toward zero and every
    // sample lands one step high, biasing the whole chroma plane.
    const int bias = delta >= 0 ? 50 : -50;
    const int scaled = 128 + (delta * static_cast<int>(percent) + bias) / 100;
    return static_cast<uint8_t>(std::clamp(scaled, 0, 255));
}



} // namespace flash
