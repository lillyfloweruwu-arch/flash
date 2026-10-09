#pragma once
#include <array>
#include <string_view>

namespace flash {
inline constexpr std::array<std::string_view, 3> kAudioTrackOrder{"game", "mic", "other"};
}
