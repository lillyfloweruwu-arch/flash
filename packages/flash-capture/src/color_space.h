#pragma once

#include <cstdint>

#ifdef _WIN32
#include <Windows.h>
#include <d3d11.h>
#include <mfapi.h>
#endif

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

#ifdef _WIN32

// Applies to encoder input and output types alike. The H.264 MFT copies these
// into the bitstream VUI and the MP4 sink turns them into the colour box.
inline void TagBt709Limited(IMFMediaType* type) {
    if (!type) return;
    type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
    type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
}

// Desktop Duplication hands over full-range BGRA. Left unset, the video
// processor's colour space struct is all zeros, which means BT.601.
inline D3D11_VIDEO_PROCESSOR_COLOR_SPACE FullRangeRgbColorSpace() {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE space{};
    space.RGB_Range = 0;   // 0-255
    space.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
    return space;
}

inline D3D11_VIDEO_PROCESSOR_COLOR_SPACE Bt709LimitedColorSpace() {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE space{};
    space.YCbCr_Matrix = 1;   // BT.709
    space.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    return space;
}

#endif

} // namespace flash
