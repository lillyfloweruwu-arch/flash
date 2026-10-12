#pragma once
#include <array>
#include <cstddef>
#include <string_view>

namespace flash {

// The audio tracks of a clip, in file order. On Windows a track is identified by
// its position, so this order is a file format: "game", "mic" and "other" keep
// the places they have had since the first clip, and anything new is appended.
inline constexpr size_t kAudioTrackCount = 5;
inline constexpr std::array<std::string_view, kAudioTrackCount> kAudioTrackOrder{
    "game", "mic", "other", "discord", "music"};

// Position of a track name, or kAudioTrackCount when it is not one.
constexpr size_t AudioTrackIndex(std::string_view id) {
    for (size_t i = 0; i < kAudioTrackCount; ++i)
        if (kAudioTrackOrder[i] == id) return i;
    return kAudioTrackCount;
}

} // namespace flash
