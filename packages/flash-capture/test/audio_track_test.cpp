#include "../src/core/audio_tracks.h"
#include "../src/core/clip_exporter.h"
#include <cassert>
#include <iostream>

int main() {
    using namespace flash;
    // Position is identity on Windows: a clip's tracks are told apart by order,
    // so the first three can never move and new ones only ever go on the end.
    static_assert(kAudioTrackCount == 5);
    static_assert(kAudioTrackOrder.size() == kAudioTrackCount);
    assert(kAudioTrackOrder[0] == "game" && kAudioTrackOrder[1] == "mic" && kAudioTrackOrder[2] == "other");
    assert(kAudioTrackOrder[3] == "discord" && kAudioTrackOrder[4] == "music");

    for (size_t i = 0; i < kAudioTrackCount; ++i) assert(AudioTrackIndex(kAudioTrackOrder[i]) == i);
    assert(AudioTrackIndex("Game") == kAudioTrackCount);     // names are exact
    assert(AudioTrackIndex("") == kAudioTrackCount);
    assert(AudioTrackIndex("system") == kAudioTrackCount);
    static_assert(AudioTrackIndex("music") == 4);            // usable at compile time

    // One gain per track, unity by default, so an export that names no gains
    // changes nothing.
    ExportOptions options;
    assert(options.gains.size() == kAudioTrackCount);
    for (float gain : options.gains) assert(gain == 1.0f);

    std::cout << "audio track self-check passed: 5 tracks (game, mic, other, discord, music)\n";
    return 0;
}
