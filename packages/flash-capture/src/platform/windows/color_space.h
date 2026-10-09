#pragma once
#include "../../core/color_space.h"
#include <Windows.h>
#include <d3d11.h>
#include <mfapi.h>
namespace flash {


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


}
