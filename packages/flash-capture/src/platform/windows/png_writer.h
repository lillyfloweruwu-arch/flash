#pragma once

#include <cstdint>
#include <string>

namespace flash {

// Encode mapped BGRA pixels as PNG. stride is the mapped D3D RowPitch and may
// be larger than width * 4.
void WritePng(const std::string& path, const uint8_t* pixels,
              uint32_t width, uint32_t height, uint32_t stride);

} // namespace flash
