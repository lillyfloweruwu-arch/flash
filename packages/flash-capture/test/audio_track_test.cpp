#include "../src/core/audio_tracks.h"
#include <iostream>

int main() {
    static_assert(flash::kAudioTrackOrder.size() == 3);
    if (flash::kAudioTrackOrder[0] != "game" || flash::kAudioTrackOrder[1] != "mic" || flash::kAudioTrackOrder[2] != "other") return 1;
    std::cout << "audio track self-check passed: 3 tracks (game, mic, other)\n";
    return 0;
}
