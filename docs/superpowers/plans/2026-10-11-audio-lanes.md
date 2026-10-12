# Audio Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New clips carry five audio tracks (game, mic, other, discord, music); on Windows each app making sound is captured separately and routed to the lane the user picked; the editor shows five lanes.

**Architecture:** The track order, the app-to-lane rule and a fixed-cadence lane mixer are portable header-only code in `packages/flash-capture/src/core`, unit-tested on both CI jobs. The Windows `AudioCapture` keeps its existing game and microphone sources untouched and replaces the single "everything but the game" source with a scanner that starts one process-loopback capture per app and feeds three mixers (discord, music, other). The desktop app stores the user's lists in settings, pushes them to the addon, and renders lanes by name. Linux gets the file format, export and UI; its capture is unchanged.

**Tech Stack:** C++20, WASAPI process loopback and audio session enumeration (Windows), Media Foundation sink writer, N-API addon via cmake-js, Electron + React + TypeScript, GitHub Actions (Windows and Ubuntu jobs).

**Spec:** `docs/superpowers/specs/2026-10-11-flash-audio-lanes-design.md`

## Global Constraints

- Track order in a file, by position: `game, mic, other, discord, music`. The first three never move. A clip written before this change has three tracks and must decode as game, mic, other.
- A new Windows clip with any audio always carries all five tracks, silent ones included.
- Lane rule, in this order: in the game's process tree is Game; one of Flash's own processes is not recorded; name in the Discord list is Discord; name in the Music list is Music; anything else is Other. Names compare case-insensitively. An app in both lists is Discord.
- Defaults: Discord list `discord.exe`, Music list `spotify.exe`. Setting key `audioLanes: { discord: string[], music: string[] }`, lower-case executable names.
- Game and Mic capture paths are not modified. Only Discord, Music and Other go through the lane mixer.
- Mixer output: 48 kHz stereo float, packets of exactly 480 frames (10 ms), timestamps from a running sample count anchored to the capture clock. Hold 30 ms before output. A source with more than 230 ms buffered is cut back to 30 ms, oldest audio dropped.
- App scan every 2 seconds across all active render devices. A capture is dropped when its process exits or after 30 seconds with no audio session. At most 16 app captures.
- With no game detected and per-app capture available, Game is silent and desktop sound goes to Discord, Music and Other. The whole-system-mix fallback (into the `game` track, as today) remains only when process loopback is unavailable.
- Linux: capture is unchanged (desktop sound to `other`, microphone to `mic`). `capabilities.perAppAudio` is `false` and `listAudioApps()` returns `[]` there. No Linux source is run locally; the Ubuntu CI job compiles it.
- Work on branch `audio-lanes`. Do not push until the task that says to. Never stage `apps/desktop/.impeccable/hook.cache.json` or anything under `.superpowers/`.
- No new npm packages and no new native libraries.

## Review Focus

1. An old three-track clip opened after the change. Expect game, mic, other on the right lanes and no phantom Discord or Music lane. Pinned in Task 1 (decode test on a real old clip) and Task 5 (lane list built from decoded tracks).
2. An app that starts making sound mid-recording, stops, and starts again. Expect silence before and between, never repeated or shifted audio. Pinned in Task 3 (mixer late-start and gap tests).
3. Settings containing junk (`audioLanes: "x"`, non-string entries, paths, an app in both lists). Expect the defaults or a cleaned list, never a crash at startup. Pinned in Task 5 (`sanitiseAudioLanes` tests).
4. A process ID reused by an unrelated program, or a parent chain that loops. Expect app grouping to terminate and not merge unrelated apps. Pinned in Task 2 (cycle and reuse tests).
5. Turning "Record audio" off and on while apps are playing. Expect all five lanes to stop and resume, and the microphone device to be released while off, as today. Pinned in Task 4 (probe toggles `setAudioTracks` and saves a clip on each side).

---

### Task 1: Five-track file format

**Files:**
- Modify: `packages/flash-capture/src/core/audio_tracks.h`
- Modify: `packages/flash-capture/src/core/clip_exporter.h` (gains array)
- Modify: `packages/flash-capture/src/platform/windows/clip_writer.cpp` (stream array size)
- Modify: `packages/flash-capture/src/binding.cpp` (track flags, `SetAudioTracks`, `GetStatus`, `SetCurrentGame`, export gains)
- Modify: `packages/flash-capture/src/platform/linux/libav_muxer.cpp` (three places that list the names)
- Modify: `scripts/probes/record-and-save.js` (expects 3 tracks)
- Test: `packages/flash-capture/test/audio_track_test.cpp`

**Interfaces:**
- Consumes: nothing.
- Produces, in namespace `flash` (`core/audio_tracks.h`):
  - `inline constexpr std::array<std::string_view, 5> kAudioTrackOrder{"game", "mic", "other", "discord", "music"};`
  - `inline constexpr size_t kAudioTrackCount = 5;`
  - `constexpr size_t AudioTrackIndex(std::string_view id)` returning the position, or `kAudioTrackCount` for an unknown name.
  - `ExportOptions::gains` becomes `std::array<float, 5>`, all `1.0f`.
  - JS: `setAudioTracks({ game, mic, other, discord?, music? })` (booleans; `discord` and `music` default to `other`'s value when omitted); `getStatus().audioTracks` has five booleans; export `gains` accepts `discord` and `music`.

- [ ] **Step 1: Create the branch**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
git checkout -b audio-lanes
git add docs/superpowers/plans/2026-10-11-audio-lanes.md
git commit -m "docs: audio lanes implementation plan"
```

- [ ] **Step 2: Write the failing test**

Replace `packages/flash-capture/test/audio_track_test.cpp` with:

```cpp
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
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/packages/flash-capture"
cmake --build build --config Release --target flash_audio_track_test
```

Expected: the build FAILS (`kAudioTrackCount`: undeclared identifier).

- [ ] **Step 4: The header**

Replace `packages/flash-capture/src/core/audio_tracks.h` with:

```cpp
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
```

- [ ] **Step 5: Export gains**

In `packages/flash-capture/src/core/clip_exporter.h`, add `#include "audio_tracks.h"` under the existing includes, and replace

```cpp
    // One gain per track in kAudioTrackOrder: game, mic, other. Zero is silence.
    std::array<float, 3> gains{1.0f, 1.0f, 1.0f};
```

with

```cpp
    // One gain per track, in kAudioTrackOrder. Zero is silence.
    std::array<float, kAudioTrackCount> gains{1.0f, 1.0f, 1.0f, 1.0f, 1.0f};
```

- [ ] **Step 6: Windows writer**

In `packages/flash-capture/src/platform/windows/clip_writer.cpp`, replace `std::array<AudioStream, 3> audioStreams{};` with `std::array<AudioStream, kAudioTrackCount> audioStreams{};`, and in the comment directly below it change "all three tracks" to "every track". Nothing else in the writer changes: it already loops over `kAudioTrackOrder` and already writes silence into a track that has no packets.

`audio_decode.cpp` needs no edit: it takes `min(streams in the file, kAudioTrackOrder.size())` tracks and names them by position, which is exactly the rule for old and new clips.

- [ ] **Step 7: Binding**

In `packages/flash-capture/src/binding.cpp`:

Add `#include "core/audio_tracks.h"` if the file does not already include it (check the include block; use the same relative form as its neighbours).

Replace the state line `bool audioGame = true, audioMic = true, audioOther = true;` with:

```cpp
// Whether each track is recorded, in kAudioTrackOrder.
std::array<bool, kAudioTrackCount> audioEnabled{true, true, true, true, true};
```

(add `#include <array>` if missing).

In `GetStatus`, replace the line that sets `"game"`, `"mic"`, `"other"` on `tracks` with:

```cpp
    for (size_t i = 0; i < kAudioTrackCount; ++i) tracks.Set(std::string(kAudioTrackOrder[i]), Napi::Boolean::New(info.Env(), audioEnabled[i]));
    result.Set("audioTracks", tracks);
```

In `SetCurrentGame`, replace the three locals `game, mic, other` and the three `SetSource` calls: capture a copy `const auto enabled = audioEnabled;` inside the existing lock in place of the three assignments, and after `audio->SetGameProcess(processId);` call

```cpp
        for (size_t i = 0; i < kAudioTrackCount; ++i) audio->SetSource(std::string(kAudioTrackOrder[i]), enabled[i], 1.0f);
```

Replace the body of `SetAudioTracks` with:

```cpp
Napi::Value SetAudioTracks(const Napi::CallbackInfo& info) {
    const char* shape = "audio tracks must be { game, mic, other, discord?, music? } booleans";
    if (!info.Length() || !info[0].IsObject()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto value = info[0].As<Napi::Object>();
    std::array<bool, kAudioTrackCount> next{};
    for (size_t i = 0; i < kAudioTrackCount; ++i) {
        const auto field = value.Get(std::string(kAudioTrackOrder[i]));
        // The two newer lanes may be left out by an older caller; they then
        // follow "other", which is where their sound used to be recorded.
        if (field.IsUndefined() && i >= 3) { next[i] = next[2]; continue; }
        if (!field.IsBoolean()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
        next[i] = field.As<Napi::Boolean>();
    }
    std::lock_guard lock(stateMutex); audioEnabled = next;
    if (audioCapture) for (size_t i = 0; i < kAudioTrackCount; ++i) audioCapture->SetSource(std::string(kAudioTrackOrder[i]), audioEnabled[i], 1.0f);
    return info.Env().Undefined();
}
```

In `ExportClipBinding`, replace the two lines

```cpp
        // Indices follow kAudioTrackOrder: game, mic, other.
        const Napi::Value byTrack[] = {gains.Get("game"), gains.Get("mic"), gains.Get("other")};
        for (size_t i = 0; i < parsed.gains.size(); ++i) {
            if (!byTrack[i].IsNumber()) continue;
            const double gain = byTrack[i].As<Napi::Number>().DoubleValue();
```

with

```cpp
        for (size_t i = 0; i < parsed.gains.size(); ++i) {
            const Napi::Value named = gains.Get(std::string(kAudioTrackOrder[i]));
            if (!named.IsNumber()) continue;
            const double gain = named.As<Napi::Number>().DoubleValue();
```

Search the file for any remaining `audioGame`, `audioMic` or `audioOther` and replace each with the matching `audioEnabled[0]`, `[1]`, `[2]`.

- [ ] **Step 8: Linux muxer (compiled by CI, not here)**

In `packages/flash-capture/src/platform/linux/libav_muxer.cpp`, add `#include "../../core/audio_tracks.h"` to the include block if absent, then:

In `DecodePcm`, replace

```cpp
        if (!title || (std::string(title->value) != "game" && std::string(title->value) != "mic" && std::string(title->value) != "other"))
```

with

```cpp
        if (!title || AudioTrackIndex(title->value) == kAudioTrackCount)
```

In `WriteCodec`, replace `for (const std::string id : {"game", "mic", "other"}) {` with:

```cpp
        for (const std::string_view name : kAudioTrackOrder) {
            const std::string id(name);
```

In `ExportOnce`, replace

```cpp
            const float gain = options.gains[track.id == "game" ? 0 : track.id == "mic" ? 1 : 2];
```

with

```cpp
            // A track this build does not know keeps unity gain and is still mixed.
            const size_t position = AudioTrackIndex(track.id);
            const float gain = position < kAudioTrackCount ? options.gains[position] : 1.0f;
```

Re-read the three edits against the surrounding lines: `id` must still be a `std::string` wherever the loop body uses it, and `<string_view>` must be reachable (it is, through `audio_tracks.h`).

- [ ] **Step 9: Probe that counted three**

In `scripts/probes/record-and-save.js`, change `audio.tracks.length === 3` to `audio.tracks.length === 5`.

- [ ] **Step 10: Build and verify**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm --filter @flash/capture run build
cd packages/flash-capture && cmake --build build --config Release --target flash_audio_track_test && ./build/Release/flash_audio_track_test.exe && cd ../..
pnpm test
```

Expected: `audio track self-check passed: 5 tracks (game, mic, other, discord, music)`; `pnpm test` ends `all checks passed`.

Old clip, new decoder (the first Review Focus item):

```bash
node -e "
const a=require('./packages/flash-capture/build/Release/flash_capture.node');
a.decodeClipAudio('C:/Users/emers/Videos/Flash/Minecraft (Java)/2026-09-29_15-31-37.mp4').then(r=>{
  console.log(r.tracks.map(t=>t.id).join(','));
  if (r.tracks.map(t=>t.id).join(',')!=='game,mic,other') process.exit(1);
})"
```

Expected: `game,mic,other`.

New clip, five tracks (records the screen for 20 s; the installed Flash may stay running):

```bash
node scripts/probes/record-and-save.js
```

Expected: a line `audio tracks: game(...) mic(...) other(...) discord(...) music(...)` and `PASS`.

- [ ] **Step 11: Commit**

```bash
git add packages/flash-capture/src/core/audio_tracks.h packages/flash-capture/src/core/clip_exporter.h packages/flash-capture/src/platform/windows/clip_writer.cpp packages/flash-capture/src/binding.cpp packages/flash-capture/src/platform/linux/libav_muxer.cpp packages/flash-capture/test/audio_track_test.cpp scripts/probes/record-and-save.js
git commit -m "feat(audio): five-track clip format (discord and music appended)"
```

---

### Task 2: Lane rule and app grouping

**Files:**
- Create: `packages/flash-capture/src/core/audio_lanes.h`
- Create: `packages/flash-capture/test/audio_lanes_test.cpp`
- Modify: `packages/flash-capture/CMakeLists.txt` (register the test)

**Interfaces:**
- Consumes: `ProcessInfo` from `core/process_list.h` (fields used: `pid`, `parentPid`, `exe`, `startTicks`).
- Produces, in namespace `flash`:
  - `struct AudioLaneConfig { std::vector<std::string> discord, music; };` (lower-case executable names)
  - `enum class AudioLane { Game, Discord, Music, Other, None };`
  - `std::string LowerAscii(std::string_view text)`
  - `std::string_view AudioLaneTrack(AudioLane lane)` returning `"game"`, `"discord"`, `"music"`, `"other"`, or `""` for `None`
  - `AudioLane LaneForApp(std::string_view exe, bool inGameTree, bool isSelf, const AudioLaneConfig& config)`
  - `uint32_t AppRoot(uint32_t pid, const std::vector<ProcessInfo>& processes)`
  - `bool IsInProcessTree(uint32_t pid, uint32_t ancestorPid, const std::vector<ProcessInfo>& processes)`

- [ ] **Step 1: Write the failing test**

Create `packages/flash-capture/test/audio_lanes_test.cpp`:

```cpp
// Self-check for the rule that decides which audio lane an app is recorded to,
// and for grouping an app's processes. Pure logic, runs on every platform.
#include "../src/core/audio_lanes.h"
#include <cassert>
#include <cstdio>

using namespace flash;

static ProcessInfo Proc(uint32_t pid, uint32_t parent, const char* exe, int64_t started) {
    ProcessInfo p; p.pid = pid; p.parentPid = parent; p.exe = exe; p.startTicks = started; return p;
}

int main() {
    const AudioLaneConfig config{{"discord.exe", "discordptb.exe"}, {"spotify.exe", "discord.exe"}};

    // The rule, in its order.
    assert(LaneForApp("RocketLeague.exe", true, false, config) == AudioLane::Game);
    assert(LaneForApp("Discord.exe", true, false, config) == AudioLane::Game);      // the game tree wins
    assert(LaneForApp("Flash.exe", false, true, config) == AudioLane::None);        // Flash never records itself
    assert(LaneForApp("Spotify.exe", false, true, config) == AudioLane::None);
    assert(LaneForApp("Discord.exe", false, false, config) == AudioLane::Discord);  // case does not matter
    assert(LaneForApp("DISCORDPTB.EXE", false, false, config) == AudioLane::Discord);
    assert(LaneForApp("discord.exe", false, false, config) == AudioLane::Discord);  // in both lists: Discord
    assert(LaneForApp("Spotify.exe", false, false, config) == AudioLane::Music);
    assert(LaneForApp("chrome.exe", false, false, config) == AudioLane::Other);
    assert(LaneForApp("", false, false, config) == AudioLane::Other);
    assert(LaneForApp("spotify.exe", false, false, AudioLaneConfig{}) == AudioLane::Other);

    assert(AudioLaneTrack(AudioLane::Game) == "game");
    assert(AudioLaneTrack(AudioLane::Discord) == "discord");
    assert(AudioLaneTrack(AudioLane::Music) == "music");
    assert(AudioLaneTrack(AudioLane::Other) == "other");
    assert(AudioLaneTrack(AudioLane::None).empty());
    assert(LowerAscii("DiscOrd.EXE") == "discord.exe");

    // Discord is six processes of one executable under one root: one app.
    std::vector<ProcessInfo> all{
        Proc(100, 4, "explorer.exe", 10),
        Proc(200, 100, "Discord.exe", 20),
        Proc(201, 200, "Discord.exe", 21), Proc(202, 200, "discord.exe", 22),
        Proc(203, 202, "Discord.exe", 23),
        Proc(300, 100, "RocketLeague.exe", 30),
        Proc(301, 300, "EasyAntiCheat.exe", 31),
        Proc(302, 301, "helper.exe", 32),
    };
    for (uint32_t pid : {200u, 201u, 202u, 203u}) assert(AppRoot(pid, all) == 200);
    assert(AppRoot(300, all) == 300);
    assert(AppRoot(301, all) == 301);          // a different name is a different app...
    assert(AppRoot(999, all) == 999);          // unknown pid is its own root

    // ...but it is still inside the game's tree, whatever it is called.
    assert(IsInProcessTree(300, 300, all));
    assert(IsInProcessTree(301, 300, all));
    assert(IsInProcessTree(302, 300, all));
    assert(!IsInProcessTree(200, 300, all));
    assert(!IsInProcessTree(300, 0, all));     // no game
    assert(!IsInProcessTree(999, 300, all));

    // A process ID reused by something unrelated: the "parent" started after
    // the child, so it cannot be its parent. Grouping must not climb into it.
    std::vector<ProcessInfo> reused{
        Proc(50, 0, "Spotify.exe", 500),       // newer process that took a dead parent's pid
        Proc(60, 50, "Spotify.exe", 100),      // older "child"
    };
    assert(AppRoot(60, reused) == 60);
    assert(!IsInProcessTree(60, 50, reused));

    // A parent chain that loops must terminate.
    std::vector<ProcessInfo> loop{Proc(1, 2, "a.exe", 0), Proc(2, 1, "a.exe", 0)};
    const uint32_t root = AppRoot(1, loop);
    assert(root == 1 || root == 2);
    assert(!IsInProcessTree(1, 77, loop));

    std::puts("audio lanes self-check passed");
    return 0;
}
```

In `packages/flash-capture/CMakeLists.txt`, after the line `flash_add_test(flash_audio_track_test test/audio_track_test.cpp)` add:

```cmake
flash_add_test(flash_audio_lanes_test test/audio_lanes_test.cpp)
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm --filter @flash/capture run build
cd packages/flash-capture && cmake --build build --config Release --target flash_audio_lanes_test
```

Expected: FAILS, `audio_lanes.h`: No such file or directory.

- [ ] **Step 3: Write the header**

Create `packages/flash-capture/src/core/audio_lanes.h`:

```cpp
#pragma once
#include "process_list.h"

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace flash {

// Which executables the user counts as Discord and as Music. Lower case.
struct AudioLaneConfig {
    std::vector<std::string> discord, music;
};

// None means "do not record this app at all".
enum class AudioLane { Game, Discord, Music, Other, None };

inline std::string LowerAscii(std::string_view text) {
    std::string lowered(text);
    for (char& c : lowered) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return lowered;
}

// The track an app's sound is written to.
inline std::string_view AudioLaneTrack(AudioLane lane) {
    switch (lane) {
        case AudioLane::Game: return "game";
        case AudioLane::Discord: return "discord";
        case AudioLane::Music: return "music";
        case AudioLane::Other: return "other";
        default: return "";
    }
}

// The whole routing rule. The game's own tree always wins, so an overlay or
// voice helper the game starts is game sound. Flash is never recorded: its
// "clip saved" sound and editor playback would otherwise end up in the clip.
// An app in both lists is Discord.
inline AudioLane LaneForApp(std::string_view exe, bool inGameTree, bool isSelf, const AudioLaneConfig& config) {
    if (inGameTree) return AudioLane::Game;
    if (isSelf) return AudioLane::None;
    const std::string name = LowerAscii(exe);
    const auto listed = [&](const std::vector<std::string>& list) {
        return std::find(list.begin(), list.end(), name) != list.end();
    };
    if (listed(config.discord)) return AudioLane::Discord;
    if (listed(config.music)) return AudioLane::Music;
    return AudioLane::Other;
}

namespace audio_lanes_detail {
inline const ProcessInfo* Find(const std::vector<ProcessInfo>& processes, uint32_t pid) {
    for (const auto& process : processes) if (process.pid == pid) return &process;
    return nullptr;
}
// The real parent of a process, or null. Windows keeps a dead parent's pid in
// the child and may hand that pid to a new, unrelated process; a "parent" that
// started after its child is such an impostor.
inline const ProcessInfo* Parent(const std::vector<ProcessInfo>& processes, const ProcessInfo& child) {
    if (!child.parentPid || child.parentPid == child.pid) return nullptr;
    const ProcessInfo* parent = Find(processes, child.parentPid);
    if (!parent) return nullptr;
    if (parent->startTicks && child.startTicks && parent->startTicks > child.startTicks) return nullptr;
    return parent;
}
constexpr int kMaxDepth = 64;   // also what stops a looping chain
} // namespace audio_lanes_detail

// An app is the topmost ancestor that shares the executable name: Discord and
// Spotify run half a dozen processes each, and capturing the root as a tree
// records all of them once.
inline uint32_t AppRoot(uint32_t pid, const std::vector<ProcessInfo>& processes) {
    using namespace audio_lanes_detail;
    const ProcessInfo* current = Find(processes, pid);
    if (!current) return pid;
    for (int depth = 0; depth < kMaxDepth; ++depth) {
        const ProcessInfo* parent = Parent(processes, *current);
        if (!parent || LowerAscii(parent->exe) != LowerAscii(current->exe)) break;
        current = parent;
    }
    return current->pid;
}

// Whether pid is ancestorPid or runs underneath it, by any executable name.
inline bool IsInProcessTree(uint32_t pid, uint32_t ancestorPid, const std::vector<ProcessInfo>& processes) {
    using namespace audio_lanes_detail;
    if (!ancestorPid) return false;
    const ProcessInfo* current = Find(processes, pid);
    for (int depth = 0; current && depth < kMaxDepth; ++depth) {
        if (current->pid == ancestorPid) return true;
        current = Parent(processes, *current);
    }
    return false;
}

} // namespace flash
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/packages/flash-capture"
cmake --build build --config Release --target flash_audio_lanes_test && ./build/Release/flash_audio_lanes_test.exe
```

Expected: `audio lanes self-check passed`.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
git add packages/flash-capture/src/core/audio_lanes.h packages/flash-capture/test/audio_lanes_test.cpp packages/flash-capture/CMakeLists.txt
git commit -m "feat(audio): lane rule and app grouping"
```

---

### Task 3: Lane mixer

**Files:**
- Create: `packages/flash-capture/src/core/lane_mixer.h`
- Create: `packages/flash-capture/test/lane_mixer_test.cpp`
- Modify: `packages/flash-capture/CMakeLists.txt` (register the test)

**Interfaces:**
- Consumes: nothing.
- Produces, in namespace `flash`:

```cpp
class LaneMixer {
public:
    static constexpr uint32_t kRate = 48000, kChannels = 2, kPacketFrames = 480;
    static constexpr int64_t kHoldFrames = 1440;          // 30 ms
    static constexpr int64_t kMaxBufferedFrames = 11040;  // 230 ms
    static constexpr int64_t kGapFrames = 960;            // 20 ms
    struct Packet { std::vector<float> samples; int64_t startUs = 0; };
    void Push(uint64_t source, const float* samples, uint32_t frames, int64_t startUs);  // interleaved stereo 48 kHz
    void Remove(uint64_t source);
    void Pull(int64_t nowUs, std::vector<Packet>& out);   // appends finished packets to out
};
```

One deliberate difference from the spec's wording: a 10 ms stretch in which no source had any sound is not emitted as a packet of zeros. The timeline still advances, and the clip writer already writes silence wherever a track has no packet. This keeps three mostly idle lanes from filling the replay buffer with zeros (about 1 MB per second otherwise).

- [ ] **Step 1: Write the failing test**

Create `packages/flash-capture/test/lane_mixer_test.cpp`:

```cpp
// Self-check for the mixer that turns several apps' audio into one continuous
// track. Pure logic with explicit clocks, so every case is deterministic.
#include "../src/core/lane_mixer.h"
#include <cassert>
#include <cmath>
#include <cstdio>

using namespace flash;

static std::vector<float> Tone(uint32_t frames, float value) {
    return std::vector<float>(static_cast<size_t>(frames) * LaneMixer::kChannels, value);
}
static bool Near(float a, float b) { return std::fabs(a - b) < 1e-6f; }
// Microseconds at which `frames` frames have elapsed.
static int64_t Us(int64_t frames) { return frames * 1000000 / LaneMixer::kRate; }

int main() {
    const int64_t hold = Us(LaneMixer::kHoldFrames);   // 30000

    // Two apps on one lane are summed.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f), b = Tone(480, 0.5f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(2, b.data(), 480, 0);
        mixer.Pull(Us(480) + hold, out);
        assert(out.size() == 1 && out[0].startUs == 0);
        assert(out[0].samples.size() == 960);
        for (float s : out[0].samples) assert(Near(s, 0.75f));
    }

    // The sum is limited to full scale, never wrapped.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.8f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(2, a.data(), 480, 0);
        mixer.Pull(Us(480) + hold, out);
        assert(out.size() == 1);
        for (float s : out[0].samples) assert(Near(s, 1.0f));
    }

    // An app that starts 5 ms late leaves silence before it, exactly.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f), b = Tone(480, 0.5f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(2, b.data(), 480, Us(240));
        mixer.Pull(Us(960) + hold, out);
        assert(out.size() == 2);
        assert(Near(out[0].samples[0], 0.25f) && Near(out[0].samples[239 * 2], 0.25f));
        assert(Near(out[0].samples[240 * 2], 0.75f) && Near(out[0].samples[479 * 2 + 1], 0.75f));
        assert(out[1].startUs == Us(480));
        assert(Near(out[1].samples[0], 0.5f) && Near(out[1].samples[239 * 2], 0.5f));
        assert(Near(out[1].samples[240 * 2], 0.0f) && Near(out[1].samples[479 * 2], 0.0f));
    }

    // A gap in one app is silence, not a repeat and not a shift: the audio
    // after the gap lands where its timestamp says.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Push(1, a.data(), 480, Us(1920));
        mixer.Pull(Us(2400) + hold, out);
        assert(out.size() == 2);                       // the three silent stretches are not emitted
        assert(out[0].startUs == 0 && out[1].startUs == Us(1920));
        for (float s : out[1].samples) assert(Near(s, 0.25f));
    }
    // Same thing when the mixer drained in between.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Pull(Us(960) + hold, out);
        mixer.Push(1, a.data(), 480, Us(1920));
        mixer.Pull(Us(2400) + hold, out);
        assert(out.size() == 2 && out[1].startUs == Us(1920));
    }

    // Output is exactly 10 ms packets, contiguous and in order. Packets pushed
    // back to back are joined by counting samples, not by their timestamps:
    // the second one below claims to start 3 ms early and must not overlap.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(2400, 0.1f);
        mixer.Push(1, a.data(), 2400, 0);
        mixer.Push(1, a.data(), 2400, Us(2400) - 3000);
        mixer.Pull(Us(4800) + hold, out);
        assert(out.size() == 10);
        for (size_t i = 0; i < out.size(); ++i) {
            assert(out[i].samples.size() == 960);
            assert(out[i].startUs == static_cast<int64_t>(i) * 10000);
            for (float s : out[i].samples) assert(Near(s, 0.1f));
        }
    }

    // An app whose audio piles up (a faster clock) loses its oldest audio and
    // keeps its newest.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        std::vector<float> ramp(12000 * 2);
        for (size_t i = 0; i < 12000; ++i) ramp[i * 2] = ramp[i * 2 + 1] = static_cast<float>(i + 1) / 12000.0f;
        mixer.Push(1, ramp.data(), 12000, 0);
        mixer.Pull(Us(14400), out);
        // 12000 buffered is over the limit, so all but the last 1440 frames go.
        assert(out.size() == 3);
        assert(out[0].startUs == Us(10560));
        assert(Near(out[0].samples[0], 10561.0f / 12000.0f));
        assert(Near(out[2].samples[479 * 2], 1.0f));
    }

    // No apps: nothing is emitted, and the timeline still moves, so the first
    // real packet afterwards is stamped with its own time.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        mixer.Pull(Us(4800), out);
        assert(out.empty());
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, Us(4800));
        mixer.Pull(Us(5280) + hold, out);
        assert(out.size() == 1 && out[0].startUs == Us(4800));
    }

    // Audio that arrives for a moment already written is trimmed, not shifted.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Pull(0, out);
        mixer.Pull(Us(3360) + hold, out);              // everything up to frame 3360 is settled
        const auto a = Tone(480, 0.5f);
        mixer.Push(2, a.data(), 480, Us(3120));        // its first 240 frames are in the past
        mixer.Pull(Us(3840) + hold, out);
        assert(out.size() == 1 && out[0].startUs == Us(3360));
        assert(Near(out[0].samples[0], 0.5f) && Near(out[0].samples[239 * 2], 0.5f));
        assert(Near(out[0].samples[240 * 2], 0.0f));
    }

    // A removed app contributes nothing further.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 480, 0);
        mixer.Remove(1);
        mixer.Pull(Us(480) + hold, out);
        assert(out.empty());
        mixer.Remove(42);                              // unknown source is fine
    }

    // Bad input is ignored.
    {
        LaneMixer mixer; std::vector<LaneMixer::Packet> out;
        mixer.Push(1, nullptr, 480, 0);
        const auto a = Tone(480, 0.25f);
        mixer.Push(1, a.data(), 0, 0);
        mixer.Pull(Us(960) + hold, out);
        assert(out.empty());
    }

    std::puts("lane mixer self-check passed");
    return 0;
}
```

In `packages/flash-capture/CMakeLists.txt`, after the `flash_audio_lanes_test` line add:

```cmake
flash_add_test(flash_lane_mixer_test test/lane_mixer_test.cpp)
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm --filter @flash/capture run build
cd packages/flash-capture && cmake --build build --config Release --target flash_lane_mixer_test
```

Expected: FAILS, `lane_mixer.h`: No such file or directory.

- [ ] **Step 3: Write the mixer**

Create `packages/flash-capture/src/core/lane_mixer.h`:

```cpp
#pragma once
#include <algorithm>
#include <cstdint>
#include <deque>
#include <map>
#include <vector>

namespace flash {

// Turns the audio of several apps into one continuous track.
//
// The clip writer wants a single stream of packets per track. Two apps feeding
// one lane would hand it overlapping packets, so each lane has one of these:
// apps push what they captured, stamped with the capture clock, and the lane
// pulls fixed 10 ms packets holding the sum.
//
// Time is counted in samples. A source's first packet is placed by its
// timestamp; everything it pushes after that is laid end to end, because
// capture timestamps are taken when a packet is drained, and under load several
// drain at once and claim nearly the same instant. Only a real pause (more than
// kGapFrames) is trusted as a gap. Output packets are stamped from the count of
// samples already emitted, so they are contiguous by construction.
//
// Not thread-safe: the owner serialises Push, Remove and Pull.
class LaneMixer {
public:
    static constexpr uint32_t kRate = 48000, kChannels = 2, kPacketFrames = 480;
    // Output trails the clock by this much, so a packet that is drained a
    // little late still lands in place.
    static constexpr int64_t kHoldFrames = 1440;          // 30 ms
    // A source that has this much waiting is running ahead of the clock (its
    // device is faster, or the mixer stalled). It is cut back to the hold.
    static constexpr int64_t kMaxBufferedFrames = 11040;  // 230 ms
    static constexpr int64_t kGapFrames = 960;            // 20 ms

    struct Packet {
        std::vector<float> samples;   // kPacketFrames interleaved stereo frames
        int64_t startUs = 0;
    };

    void Push(uint64_t source, const float* samples, uint32_t frames, int64_t startUs) {
        if (!samples || !frames) return;
        if (!started_) { originUs_ = startUs; started_ = true; }
        int64_t position = FrameAt(startUs);
        Source& s = sources_[source];
        const int64_t buffered = Buffered(s);
        uint32_t skip = 0;
        if (!buffered) {
            // Starting, or resuming after running dry: trust the timestamp,
            // but never write into time that has already been emitted.
            if (position < emitted_) {
                skip = static_cast<uint32_t>((std::min)(static_cast<int64_t>(frames), emitted_ - position));
                position = emitted_;
            }
            s.front = position;
        } else {
            const int64_t gap = position - (s.front + buffered);
            if (gap > kMaxBufferedFrames) {
                s.samples.clear();
                s.front = position;
            } else if (gap > kGapFrames) {
                s.samples.insert(s.samples.end(), static_cast<size_t>(gap) * kChannels, 0.0f);
            }
        }
        s.samples.insert(s.samples.end(), samples + static_cast<size_t>(skip) * kChannels,
                         samples + static_cast<size_t>(frames) * kChannels);
        const int64_t waiting = Buffered(s);
        if (waiting > kMaxBufferedFrames) {
            const int64_t drop = waiting - kHoldFrames;
            s.samples.erase(s.samples.begin(), s.samples.begin() + static_cast<std::ptrdiff_t>(drop * kChannels));
            s.front += drop;
        }
    }

    void Remove(uint64_t source) { sources_.erase(source); }

    // Appends every packet that is complete as of nowUs. Stretches in which no
    // source had any sound are skipped: the timeline advances, nothing is
    // emitted, and the clip writer fills the silence.
    void Pull(int64_t nowUs, std::vector<Packet>& out) {
        if (!started_) { originUs_ = nowUs; started_ = true; }
        const int64_t ready = FrameAt(nowUs) - kHoldFrames;
        while (emitted_ + kPacketFrames <= ready) {
            Packet packet;
            packet.samples.assign(static_cast<size_t>(kPacketFrames) * kChannels, 0.0f);
            packet.startUs = originUs_ + emitted_ * 1000000 / kRate;
            const int64_t end = emitted_ + kPacketFrames;
            bool audible = false;
            for (auto& entry : sources_) {
                Source& s = entry.second;
                const int64_t buffered = Buffered(s);
                if (!buffered || s.front >= end) continue;
                const int64_t to = (std::min)(s.front + buffered, end);
                for (int64_t frame = s.front; frame < to; ++frame) {
                    for (uint32_t c = 0; c < kChannels; ++c) {
                        const float value = s.samples[static_cast<size_t>(frame - s.front) * kChannels + c];
                        if (value != 0.0f) audible = true;
                        packet.samples[static_cast<size_t>(frame - emitted_) * kChannels + c] += value;
                    }
                }
                s.samples.erase(s.samples.begin(),
                                s.samples.begin() + static_cast<std::ptrdiff_t>((to - s.front) * kChannels));
                s.front = to;
            }
            emitted_ = end;
            if (!audible) continue;
            for (float& sample : packet.samples) sample = (std::max)(-1.0f, (std::min)(1.0f, sample));
            out.push_back(std::move(packet));
        }
    }

private:
    struct Source {
        std::deque<float> samples;   // interleaved, starting at frame `front`
        int64_t front = 0;           // frames since the origin
    };
    static int64_t Buffered(const Source& s) { return static_cast<int64_t>(s.samples.size() / kChannels); }
    int64_t FrameAt(int64_t timeUs) const { return (timeUs - originUs_) * kRate / 1000000; }

    std::map<uint64_t, Source> sources_;
    int64_t originUs_ = 0, emitted_ = 0;
    bool started_ = false;
};

} // namespace flash
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/packages/flash-capture"
cmake --build build --config Release --target flash_lane_mixer_test && ./build/Release/flash_lane_mixer_test.exe
```

Expected: `lane mixer self-check passed`. If an assertion fires, work out by hand which is wrong, the test's arithmetic or the mixer, before changing either; report any test value you had to change and why.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
git add packages/flash-capture/src/core/lane_mixer.h packages/flash-capture/test/lane_mixer_test.cpp packages/flash-capture/CMakeLists.txt
git commit -m "feat(audio): lane mixer with a sample-counted timeline"
```

---

### Task 4: Per-app capture on Windows and its native API

**Files:**
- Modify: `packages/flash-capture/src/core/audio_source.h`
- Modify: `packages/flash-capture/src/platform/windows/audio_capture.h`
- Modify: `packages/flash-capture/src/platform/windows/audio_capture.cpp`
- Modify: `packages/flash-capture/src/binding.cpp` (`setAudioLanes`, `listAudioApps`, `capabilities.perAppAudio`)
- Modify: `packages/flash-capture/src/core/platform.h`, `packages/flash-capture/src/platform/windows/factory.cpp`, `packages/flash-capture/src/platform/linux/factory.cpp` (`PlatformSupportsPerAppAudio`)
- Create: `scripts/probes/audio-lanes.js`
- Modify: `scripts/probes/README.md` (one table row)

**Interfaces:**
- Consumes: `AudioLaneConfig`, `AudioLane`, `LaneForApp`, `AudioLaneTrack`, `AppRoot`, `IsInProcessTree`, `LowerAscii` (Task 2); `LaneMixer` (Task 3); `ListProcesses()` from `core/process_list.h`; `CaptureClockUs()`; `ResampleStereo`; `kAudioTrackOrder` (Task 1).
- Produces:
  - In `core/audio_source.h`: `struct AudioAppInfo { std::string exe, name, lane; uint32_t pid = 0; bool capturing = false; };` and three virtuals on `AudioSource` with defaults, so the Linux backend compiles unchanged: `virtual void SetLanes(const AudioLaneConfig&) {}`, `virtual std::vector<AudioAppInfo> ListApps() const { return {}; }`, `virtual bool SupportsPerApp() const { return false; }`.
  - JS: `setAudioLanes({ discord: string[], music: string[] })`; `listAudioApps()` returning `[{ exe, name, lane, pid, capturing }]` where `lane` is `"game" | "discord" | "music" | "other"`; `capabilities.perAppAudio: boolean`.
  - `getStatus().audioMode` is `"separate"` whenever per-app capture is in use (game or no game) and `"mixed"` only on the system-mix fallback.

Background for the implementer. Read `audio_capture.cpp` in full first. Today `BuildSources(pid)` makes three sources: `game` (process loopback, include the game's tree), `mic` (default capture endpoint) and `other` (process loopback, exclude the game's tree); if either process source fails it falls back to `mixed` (the whole render endpoint, written to the `game` track) plus `mic`. Each source has a thread running `CaptureLoop`, which converts to 48 kHz stereo, stamps the packet with the capture clock and calls the callback with the source's id. Keep `InitializeEndpoint`, `InitializeProcess`, `CaptureLoop` and the `game` and `mic` handling as they are. The `other` exclude-source goes away. In its place:

- A **scanner thread** wakes every 2 s (and at once when lanes or the game change). It lists audio sessions on every active render endpoint, maps each session's process to an app root, decides the app's lane, and starts or stops one include-tree process-loopback capture per app.
- Each **app capture** has its own thread, like a source, but instead of calling the callback it pushes into the `LaneMixer` of its lane.
- A **mixer thread** wakes every 5 ms, pulls the three mixers and calls the callback with `discord`, `music` or `other` as the id.

- [ ] **Step 1: Write the failing probe**

Create `scripts/probes/audio-lanes.js`:

```js
// Per-app audio lanes on real hardware. A helper process plays a tone; its
// executable is assigned to Music, then to Discord, and the tone has to follow.
// Needs a sound device. Not part of `pnpm test`. The installed Flash may stay
// running. Whatever else is playing on the machine lands in "other" and is not
// judged.
//   node scripts/probes/audio-lanes.js
const addon = require('./addon')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawn } = require('node:child_process')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-lanes-'))

// Six seconds of a 440 Hz tone at half scale, 48 kHz stereo 16-bit.
function writeTone(file) {
  const rate = 48000, seconds = 6, frames = rate * seconds
  const data = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 16000)
    data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22)
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([head, data]))
}

// Started through `cmd /c start` so the player is not a child of this process:
// Flash never records its own process tree, and a direct child would count.
function playTone(file) {
  spawn('cmd', ['/c', 'start', '', '/b', 'powershell', '-NoProfile', '-Command',
    `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`], { detached: true, stdio: 'ignore' }).unref()
}

const dB = samples => {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

async function record(label) {
  await wait(7000)
  const clip = await addon.saveClip(5)
  const audio = await addon.decodeClipAudio(clip.path)
  const levels = Object.fromEntries(audio.tracks.map(t => [t.id, dB(t.samples)]))
  console.log(`${label}: ` + audio.tracks.map(t => `${t.id}=${levels[t.id].toFixed(1)}dB`).join('  '))
  assert.deepEqual(audio.tracks.map(t => t.id), ['game', 'mic', 'other', 'discord', 'music'])
  return levels
}

;(async () => {
  const tone = path.join(dir, 'tone.wav')
  writeTone(tone)
  assert.equal(addon.capabilities.perAppAudio, true, 'per-app audio should be available on this machine')
  console.log('init:', JSON.stringify(addon.initialize(dir, 0)))
  addon.setAudioLanes({ discord: [], music: ['powershell.exe'] })
  addon.setBufferLength(20)
  addon.startReplayBuffer()
  assert.equal(addon.getStatus().audioMode, 'separate')

  playTone(tone)
  await wait(3000)
  const apps = addon.listAudioApps()
  console.log('apps:', apps.map(a => `${a.exe}->${a.lane}${a.capturing ? '' : ' (idle)'}`).join(', '))
  const player = apps.find(a => a.exe.toLowerCase() === 'powershell.exe')
  assert.ok(player, 'the tone player should be listed')
  assert.equal(player.lane, 'music')
  assert.equal(player.capturing, true)
  assert.ok(!apps.some(a => a.exe.toLowerCase() === 'node.exe'), 'this process must not be listed: Flash does not record itself')

  const first = await record('tone assigned to music')
  assert.ok(first.music > -40, `music should carry the tone, was ${first.music.toFixed(1)} dB`)
  assert.ok(first.discord < -70, `discord should be silent, was ${first.discord.toFixed(1)} dB`)
  assert.ok(first.game < -70, 'no game is set, so the game track is silent')

  // Reassign while recording: no restart, and the next clip follows.
  addon.setAudioLanes({ discord: ['powershell.exe'], music: [] })
  await wait(8000)   // let the first tone finish and its audio leave the 5 s window
  playTone(tone)
  const second = await record('tone assigned to discord')
  assert.ok(second.discord > -40, `discord should carry the tone, was ${second.discord.toFixed(1)} dB`)
  assert.ok(second.music < -70, `music should be silent, was ${second.music.toFixed(1)} dB`)

  // Record audio off, then on again: every lane stops and resumes.
  const off = { game: false, mic: false, other: false, discord: false, music: false }
  addon.setAudioTracks(off)
  await wait(8000)
  playTone(tone)
  await wait(7000)
  const silent = await addon.saveClip(5)
  const silentAudio = await addon.decodeClipAudio(silent.path)
  console.log(`audio off: ${silentAudio.tracks.length} track(s) ` + silentAudio.tracks.map(t => `${t.id}=${dB(t.samples).toFixed(1)}dB`).join('  '))
  for (const t of silentAudio.tracks) assert.ok(dB(t.samples) < -70, `${t.id} should be silent with audio off`)
  addon.setAudioTracks({ game: true, mic: true, other: true, discord: true, music: true })
  await wait(8000)
  playTone(tone)
  const third = await record('audio back on')
  assert.ok(third.discord > -40, 'discord should carry the tone again')

  addon.stopReplayBuffer()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('PASS')
})().catch(error => {
  console.error('FAIL:', error.message)
  try { addon.stopReplayBuffer() } catch { /* already stopped */ }
  process.exit(1)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
node scripts/probes/audio-lanes.js
```

Expected: `FAIL: per-app audio should be available on this machine` (the capability does not exist yet).

- [ ] **Step 3: Extend the audio source interface**

In `packages/flash-capture/src/core/audio_source.h`, add `#include "audio_lanes.h"` under the includes, add after `AudioSourceInfo`:

```cpp
// One app that has an audio session, for the Settings picker.
struct AudioAppInfo {
    std::string exe, name, lane;   // lane is a track name: game, discord, music or other
    uint32_t pid = 0;
    bool capturing = false;
};
```

and add to `class AudioSource`, after `GetProcessError`:

```cpp
    // Per-app lanes. The defaults describe a backend that records desktop sound
    // as one stream, which is what Linux does for now.
    virtual void SetLanes(const AudioLaneConfig&) {}
    virtual std::vector<AudioAppInfo> ListApps() const { return {}; }
    virtual bool SupportsPerApp() const { return false; }
```

- [ ] **Step 4: Declare the new members**

In `packages/flash-capture/src/platform/windows/audio_capture.h`:

Add includes `"../../core/lane_mixer.h"`, `<array>`, `<condition_variable>` and `<map>`.

Add public overrides:

```cpp
    void SetLanes(const AudioLaneConfig& config) override;
    std::vector<AudioAppInfo> ListApps() const override;
    bool SupportsPerApp() const override { return perApp_; }
    // True when this Windows build can capture one process's audio.
    static bool ProcessLoopbackAvailable();
```

Add private members:

```cpp
    struct App;
    // The three lanes that are mixed from apps, in this order.
    static constexpr std::array<const char*, 3> kMixedLanes{"discord", "music", "other"};
    static int MixedLaneIndex(AudioLane lane);
    void ScanLoop();
    void ScanOnce();
    void MixLoop();
    void AppLoop(std::shared_ptr<App> app);
    void StopApps();

    bool perApp_ = false;                 // process loopback works on this Windows build
    uint32_t gamePid_ = 0;
    AudioLaneConfig lanes_;               // guarded by mutex_
    std::map<uint32_t, std::shared_ptr<App>> apps_;   // by app root pid; guarded by mutex_
    std::array<bool, 3> laneEnabled_{true, true, true};   // guarded by mutex_
    std::thread scanThread_, mixThread_;
    std::condition_variable scanWake_;
    std::mutex scanMutex_;
    bool scanNow_ = false;                // guarded by scanMutex_
    std::mutex mixMutex_;                 // guards mixers_
    std::array<LaneMixer, 3> mixers_;
```

- [ ] **Step 5: Implement it**

All in `packages/flash-capture/src/platform/windows/audio_capture.cpp`. Add includes `<audiopolicy.h>`, `"../../core/process_list.h"`, `<chrono>`.

(a) The app record, next to `struct AudioCapture::Source`:

```cpp
struct AudioCapture::App {
    uint32_t rootPid = 0;
    std::string exe, name;
    AudioLane lane = AudioLane::Other;
    int missedScans = 0;                  // scans in a row with no audio session
#ifdef _WIN32
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> capture;
    HANDLE event = nullptr;
#endif
    std::thread thread;
    std::atomic<bool> running{false};
    ~App() {
#ifdef _WIN32
        if (event) CloseHandle(event);
#endif
    }
};
```

(b) Whether process loopback exists at all. Activating a client for our own process is enough to tell, and costs nothing once released. It is a public static so the addon can report the capability at load without opening the microphone, which a full `Initialize()` would do. `InitializeProcess` touches no member state, so declare it `static` in the header as well:

```cpp
bool AudioCapture::ProcessLoopbackAvailable() {
#ifdef _WIN32
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool available = false;
    {
        auto probe = std::make_shared<Source>();
        available = InitializeProcess(probe, GetCurrentProcessId(), true);
    }   // released before COM is balanced
    if (SUCCEEDED(apartment)) CoUninitialize();
    return available;
#else
    return false;
#endif
}
```

Call it once in `Initialize()`, after COM is initialised and before `BuildSources(0)`: `perApp_ = ProcessLoopbackAvailable();`.

(c) `BuildSources(processId)` becomes: remember `gamePid_ = processId`; build `mic` as today; then

- if `perApp_`: `mode_ = "separate"`, `processError_` cleared; sources are `mic`, plus `game` when `processId != 0` and `InitializeProcess(game, processId, true)` succeeds (if it fails, record `processError_ = game->info.error` and carry on without a game source: the other lanes do not depend on it).
- otherwise: today's fallback exactly (`mixed` with id `"game"`, plus `mic`, `mode_ = "mixed"`, `processError_` saying why).

There is no `other` source any more.

(d) `Start()` additionally, when `perApp_`: reset the three mixers (`mixers_ = {}` under `mixMutex_`), then start `scanThread_` on `ScanLoop` and `mixThread_` on `MixLoop`. `Stop()` additionally: wake and join `scanThread_`, join `mixThread_`, then `StopApps()`. Order in `Stop()`: set `capturing_` false first (as today), then wake the scanner (`{ std::lock_guard l(scanMutex_); scanNow_ = true; } scanWake_.notify_all();`), join both threads, then stop the apps, then the existing source teardown.

```cpp
void AudioCapture::StopApps() {
    std::map<uint32_t, std::shared_ptr<App>> apps;
    { std::lock_guard lock(mutex_); apps.swap(apps_); }
    for (auto& entry : apps) {
        auto& app = entry.second;
        app->running.store(false);
#ifdef _WIN32
        if (app->client) app->client->Stop();
        if (app->event) SetEvent(app->event);
#endif
    }
    for (auto& entry : apps) if (entry.second->thread.joinable()) entry.second->thread.join();
}
```

(e) The scanner:

```cpp
int AudioCapture::MixedLaneIndex(AudioLane lane) {
    return lane == AudioLane::Discord ? 0 : lane == AudioLane::Music ? 1 : lane == AudioLane::Other ? 2 : -1;
}

void AudioCapture::ScanLoop() {
#ifdef _WIN32
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (capturing_.load()) {
        ScanOnce();
        std::unique_lock lock(scanMutex_);
        scanWake_.wait_for(lock, std::chrono::seconds(2), [this] { return scanNow_ || !capturing_.load(); });
        scanNow_ = false;
    }
    if (SUCCEEDED(apartment)) CoUninitialize();
#endif
}

void AudioCapture::ScanOnce() {
#ifdef _WIN32
    // Every process that has an audio session on any active output device.
    std::vector<uint32_t> sessionPids;
    ComPtr<IMMDeviceCollection> devices;
    if (enumerator_ && SUCCEEDED(enumerator_->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) {
        UINT deviceCount = 0; devices->GetCount(&deviceCount);
        for (UINT d = 0; d < deviceCount; ++d) {
            ComPtr<IMMDevice> device; ComPtr<IAudioSessionManager2> manager; ComPtr<IAudioSessionEnumerator> sessions;
            if (FAILED(devices->Item(d, &device))) continue;
            if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                    reinterpret_cast<void**>(manager.GetAddressOf())))) continue;
            if (FAILED(manager->GetSessionEnumerator(&sessions))) continue;
            int count = 0; sessions->GetCount(&count);
            for (int i = 0; i < count; ++i) {
                ComPtr<IAudioSessionControl> control; ComPtr<IAudioSessionControl2> control2;
                if (FAILED(sessions->GetSession(i, &control)) || FAILED(control.As(&control2))) continue;
                if (control2->IsSystemSoundsSession() == S_OK) continue;   // belongs to no app
                AudioSessionState state = AudioSessionStateExpired;
                if (FAILED(control->GetState(&state)) || state == AudioSessionStateExpired) continue;
                DWORD pid = 0;
                if (SUCCEEDED(control2->GetProcessId(&pid)) && pid) sessionPids.push_back(pid);
            }
        }
    }

    const ProcessSnapshot snapshot = ListProcesses();
    const auto& processes = snapshot.processes;
    const uint32_t selfRoot = AppRoot(GetCurrentProcessId(), processes);
    AudioLaneConfig config; uint32_t gamePid;
    { std::lock_guard lock(mutex_); config = lanes_; gamePid = gamePid_; }

    // The apps that should be captured right now, by root pid.
    struct Wanted { std::string exe, name; AudioLane lane; };
    std::map<uint32_t, Wanted> wanted;
    for (uint32_t pid : sessionPids) {
        const uint32_t root = AppRoot(pid, processes);
        if (wanted.count(root)) continue;
        const auto found = std::find_if(processes.begin(), processes.end(),
            [&](const ProcessInfo& p) { return p.pid == root; });
        if (found == processes.end()) continue;   // exited between the two listings
        const AudioLane lane = LaneForApp(found->exe, IsInProcessTree(root, gamePid, processes),
                                          IsInProcessTree(root, selfRoot, processes), config);
        if (MixedLaneIndex(lane) < 0) continue;   // the game has its own source; Flash is not recorded
        wanted[root] = {found->exe, found->windowTitle.empty() ? found->exe : found->windowTitle, lane};
    }

    std::vector<std::shared_ptr<App>> stopping, starting;
    bool tooMany = false;
    {
        std::lock_guard lock(mutex_);
        for (auto it = apps_.begin(); it != apps_.end();) {
            auto& app = it->second;
            const auto want = wanted.find(it->first);
            const bool alive = std::any_of(processes.begin(), processes.end(),
                [&](const ProcessInfo& p) { return p.pid == it->first; });
            app->missedScans = want == wanted.end() ? app->missedScans + 1 : 0;
            // Gone, silent for 30 s (15 scans), or no longer something we mix.
            if (!alive || app->missedScans >= 15) { stopping.push_back(app); it = apps_.erase(it); continue; }
            if (want != wanted.end() && want->second.lane != app->lane) {
                // Reassigned in Settings: its audio moves lane from now on.
                std::lock_guard mix(mixMutex_);
                mixers_[MixedLaneIndex(app->lane)].Remove(app->rootPid);
                app->lane = want->second.lane;
            }
            ++it;
        }
        for (const auto& entry : wanted) {
            if (apps_.count(entry.first)) continue;
            if (apps_.size() >= 16) { tooMany = true; break; }
            auto app = std::make_shared<App>();
            app->rootPid = entry.first; app->exe = entry.second.exe; app->name = entry.second.name; app->lane = entry.second.lane;
            apps_[entry.first] = app;
            starting.push_back(app);
        }
        if (tooMany) processError_ = "more than 16 apps are making sound; some are not recorded";
        else if (processError_.rfind("more than 16", 0) == 0) processError_.clear();
    }

    for (auto& app : stopping) {
        app->running.store(false);
        if (app->client) app->client->Stop();
        if (app->event) SetEvent(app->event);
        if (app->thread.joinable()) app->thread.join();
        std::lock_guard mix(mixMutex_);
        mixers_[MixedLaneIndex(app->lane)].Remove(app->rootPid);
    }
    for (auto& app : starting) {
        // The same activation the game source uses, pointed at this app's tree.
        auto source = std::make_shared<Source>();
        if (!InitializeProcess(source, app->rootPid, true)) {
            std::lock_guard lock(mutex_); apps_.erase(app->rootPid);   // tried again on the next scan
            continue;
        }
        app->client = source->client; app->capture = source->capture;
        app->event = source->event; source->event = nullptr;          // the App owns the handle now
        if (FAILED(app->client->Start())) { std::lock_guard lock(mutex_); apps_.erase(app->rootPid); continue; }
        app->running.store(true);
        app->thread = std::thread(&AudioCapture::AppLoop, this, app);
    }
#endif
}
```

`Source`'s destructor closes `event`; setting `source->event = nullptr` after handing it to the `App` is what prevents a double close. Check that `Source::~Source` still guards on `if (event)`.

(f) An app's capture thread. Same buffer handling as `CaptureLoop`, but the audio goes to a mixer. Process loopback is always 48 kHz stereo float (see `InitializeProcess`), so no conversion is needed:

```cpp
void AudioCapture::AppLoop(std::shared_ptr<App> app) {
#ifdef _WIN32
    const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (capturing_.load() && app->running.load()) {
        if (WaitForSingleObject(app->event, 100) != WAIT_OBJECT_0) continue;
        UINT32 packet = 0;
        if (FAILED(app->capture->GetNextPacketSize(&packet))) break;
        while (packet && capturing_.load() && app->running.load()) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            if (FAILED(app->capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
            if (frames && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                const int64_t startUs = CaptureClockUs() - static_cast<int64_t>(frames) * 1000000 / 48000;
                AudioLane lane;
                { std::lock_guard lock(mutex_); lane = app->lane; }
                const int index = MixedLaneIndex(lane);
                if (index >= 0) {
                    std::lock_guard mix(mixMutex_);
                    mixers_[index].Push(app->rootPid, reinterpret_cast<const float*>(data), frames, startUs);
                }
            }
            app->capture->ReleaseBuffer(frames);
            if (FAILED(app->capture->GetNextPacketSize(&packet))) packet = 0;
        }
    }
    if (SUCCEEDED(apartment)) CoUninitialize();
#else
    (void)app;
#endif
}
```

(g) The mixer thread:

```cpp
void AudioCapture::MixLoop() {
    std::vector<LaneMixer::Packet> packets;
    while (capturing_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        std::array<bool, 3> enabled;
        { std::lock_guard lock(mutex_); enabled = laneEnabled_; }
        for (size_t lane = 0; lane < mixers_.size(); ++lane) {
            packets.clear();
            { std::lock_guard mix(mixMutex_); mixers_[lane].Pull(CaptureClockUs(), packets); }
            // Pulled even when the lane is off, so its timeline keeps moving
            // and nothing stale comes out when it is switched back on.
            if (!enabled[lane] || !callback_) continue;
            for (auto& packet : packets) {
                AudioData value{packet.samples.data(), LaneMixer::kPacketFrames, LaneMixer::kChannels,
                                LaneMixer::kRate, packet.startUs, kMixedLanes[lane]};
                callback_(value);
            }
        }
    }
}
```

(h) `SetSource(id, enabled, gain)`: before the existing lookup in `sources_`, handle the three mixed lanes:

```cpp
    for (size_t lane = 0; lane < kMixedLanes.size(); ++lane) {
        if (id != kMixedLanes[lane]) continue;
        // On the system-mix fallback there is no such lane, and saying so would
        // make "Record audio" report a failure for something that is fine.
        std::lock_guard lock(mutex_); laneEnabled_[lane] = enabled; return true;
    }
```

Gain for mixed lanes is ignored (it is always 1.0 from the binding today).

(i) Lanes and the picker:

```cpp
void AudioCapture::SetLanes(const AudioLaneConfig& config) {
    { std::lock_guard lock(mutex_); lanes_ = config; }
    { std::lock_guard lock(scanMutex_); scanNow_ = true; }
    scanWake_.notify_all();
}

std::vector<AudioAppInfo> AudioCapture::ListApps() const {
    std::lock_guard lock(mutex_); std::vector<AudioAppInfo> result;
    for (const auto& entry : apps_) {
        const auto& app = entry.second;
        result.push_back({app->exe, app->name, std::string(AudioLaneTrack(app->lane)), app->rootPid,
                          app->running.load() && app->missedScans == 0});
    }
    return result;
}
```

`SetGameProcess` already stops, rebuilds and restarts; with `Start()` and `Stop()` extended as in (d) it needs no other change, and the first scan after the restart picks the apps up again within milliseconds.

`ListSources()` should also report the three mixed lanes so `getStatus().audioSources` stays a complete picture: after the existing loop, when `perApp_`, append one `AudioSourceInfo` per mixed lane with `id` = the lane name, `kind` = `"apps"`, `name` = `"Discord"`, `"Music"`, `"Other apps"`, `available = true`, `enabled = laneEnabled_[lane]`, `active = ` whether any app is on that lane, `sampleRate = 48000`, `channels = 2`.

- [ ] **Step 6: Binding**

In `packages/flash-capture/src/binding.cpp`:

Add a state member next to `audioEnabled`: `AudioLaneConfig audioLanes{{"discord.exe"}, {"spotify.exe"}};` (include `core/audio_lanes.h` if not reachable).

Wherever the audio source is created and initialised (the line `if (initializeAudio) { audio = CreateAudioSource(); audio->Initialize(); }`), follow it with `if (audio) audio->SetLanes(audioLanes);` so a re-created source keeps the user's lists.

Add two methods beside `SetAudioTracks`:

```cpp
Napi::Value SetAudioLanes(const Napi::CallbackInfo& info) {
    const char* shape = "audio lanes must be { discord: string[], music: string[] }";
    if (!info.Length() || !info[0].IsObject()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
    auto value = info[0].As<Napi::Object>();
    AudioLaneConfig next;
    for (auto [name, list] : {std::pair<const char*, std::vector<std::string>*>{"discord", &next.discord}, {"music", &next.music}}) {
        if (!value.Get(name).IsArray()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
        auto array = value.Get(name).As<Napi::Array>();
        for (uint32_t i = 0; i < array.Length() && i < 64; ++i) {
            const Napi::Value entry = array.Get(i);
            if (!entry.IsString()) { Napi::TypeError::New(info.Env(), shape).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
            list->push_back(LowerAscii(entry.As<Napi::String>().Utf8Value()));
        }
    }
    std::lock_guard lock(stateMutex); audioLanes = next;
    if (audioCapture) audioCapture->SetLanes(audioLanes);
    return info.Env().Undefined();
}
Napi::Value ListAudioApps(const Napi::CallbackInfo& info) {
    std::lock_guard lock(stateMutex); auto result = Napi::Array::New(info.Env());
    if (!audioCapture) return result;
    uint32_t i = 0;
    for (const auto& app : audioCapture->ListApps()) {
        auto entry = Napi::Object::New(info.Env());
        entry.Set("exe", app.exe); entry.Set("name", app.name); entry.Set("lane", app.lane);
        entry.Set("pid", app.pid); entry.Set("capturing", app.capturing);
        result.Set(i++, entry);
    }
    return result;
}
```

Export both in `Init` the same way `setAudioTracks` is exported (`exports.Set("setAudioLanes", Napi::Function::New(env, Invoke<&AddonState::SetAudioLanes>, "SetAudioLanes", this));` and likewise `listAudioApps`).

For the capability: it must be known before any capture is initialised, and asking must not open the microphone. Add a platform function next to the factories in `packages/flash-capture/src/core/platform.h`:

```cpp
// Whether desktop sound can be captured one app at a time on this machine.
bool PlatformSupportsPerAppAudio();
```

Define it in `packages/flash-capture/src/platform/windows/factory.cpp` as `bool PlatformSupportsPerAppAudio() { return AudioCapture::ProcessLoopbackAvailable(); }` and in `packages/flash-capture/src/platform/linux/factory.cpp` as `bool PlatformSupportsPerAppAudio() { return false; }` (inside `namespace flash`, beside the other factory functions; the Linux file is compiled only by CI, so read it first and match how its neighbours are written). In `Init`, where `capabilities` is filled, add `capabilities.Set("perAppAudio", PlatformSupportsPerAppAudio());` outside the platform `#ifdef`, so both platforms report it.

- [ ] **Step 7: Build and run the probe**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm --filter @flash/capture run build
node scripts/probes/audio-lanes.js
```

Expected, in order: an `apps:` line listing `powershell.exe->music`; `tone assigned to music:` with `music` above -40 dB and `discord` below -70 dB; `tone assigned to discord:` the other way round; `audio off:` with every track below -70 dB (or no tracks); `audio back on:`; then `PASS`. It plays a tone through the speakers for a few seconds, three times.

If the tone lands in `other` with `powershell.exe` listed as `other`, the lane list is not reaching the scanner. If the player is not listed at all, print `sessionPids` and each root in `ScanOnce` and check whether the player was excluded as part of this process's own tree.

- [ ] **Step 8: Everything else still passes**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm test
node scripts/probes/record-and-save.js
node scripts/probes/audio-toggle.js
node scripts/probes/audio-all-tracks-off.js
node scripts/probes/audio-starts-late.js
node scripts/probes/audio-track-gap.js
FLASH_HARDWARE_TESTS=1 node --experimental-strip-types scripts/probes/export-and-game.js
node scripts/probes/native-teardown.js
```

Expected: all pass. These exist because `saveClip` has hung before when a track stopped or started partway; the new lanes start and stop constantly, so they matter here. `export-and-game.js` prints `audio restored to mixed` in one of its PASS lines: with per-app capture the mode after a game exits is now `separate`. If that probe asserts on the word `mixed`, read what it is protecting (the game's audio target being released when the game exits) and update the assertion to the new correct value, saying so in your report. If any probe's header names arguments, follow it.

Add a row to the table in `scripts/probes/README.md`:

```
| `audio-lanes.js` | A tone played by a helper process lands on the Music track, moves to Discord when reassigned, and every lane obeys the Record audio switch |
```

- [ ] **Step 9: Commit**

```bash
git add packages/flash-capture/src/core/audio_source.h packages/flash-capture/src/core/platform.h packages/flash-capture/src/platform/windows/factory.cpp packages/flash-capture/src/platform/linux/factory.cpp packages/flash-capture/src/platform/windows/audio_capture.h packages/flash-capture/src/platform/windows/audio_capture.cpp packages/flash-capture/src/binding.cpp scripts/probes/audio-lanes.js scripts/probes/README.md
git commit -m "feat(audio): capture each app on its own and mix into Discord, Music and Other"
```

(Add any probe you had to update to the `git add`.)

---

### Task 5: Desktop app

**Files:**
- Create: `apps/desktop/src/shared/audioLanes.ts`
- Create: `apps/desktop/src/shared/audioLanes.test.ts`
- Modify: `apps/desktop/src/shared/sanitise.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.ts`
- Modify: `apps/desktop/src/renderer/SettingsView.tsx`
- Modify: `apps/desktop/src/renderer/editor/AudioLanes.tsx`
- Modify: `apps/desktop/src/renderer/editor/useClipAudio.ts`

**Interfaces:**
- Consumes: native `setAudioLanes`, `listAudioApps`, `capabilities.perAppAudio`, five-lane `setAudioTracks`, export `gains` with five names (Tasks 1 and 4).
- Produces (`shared/audioLanes.ts`):
  - `AUDIO_TRACK_IDS` = `['game', 'mic', 'other', 'discord', 'music']` (file order); `type AudioTrackId`
  - `LANE_DISPLAY_ORDER` = `['game', 'mic', 'discord', 'music', 'other']`
  - `laneLabel(id: string): string`
  - `sortLanes<T extends { id: string }>(tracks: readonly T[]): T[]`
  - `isSilent(samples: Float32Array): boolean`
  - `interface AudioLanesSetting { discord: string[]; music: string[] }`, `DEFAULT_AUDIO_LANES`
  - `sanitiseAudioLanes(value: unknown): AudioLanesSetting | undefined`
  - `assignApp(lanes: AudioLanesSetting, exe: string, lane: 'discord' | 'music' | 'other'): AudioLanesSetting`
  - IPC `list-audio-apps` and preload `window.flash.listAudioApps(): Promise<{ supported: boolean; apps: { exe: string; name: string; lane: string; capturing: boolean }[] }>`
  - Setting `audioLanes: AudioLanesSetting`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/shared/audioLanes.test.ts`:

```ts
// Self-check for audio lane naming, ordering and the Settings lists. Run with:
//   node --experimental-strip-types src/shared/audioLanes.test.ts
import { strict as assert } from 'node:assert'
import {
  AUDIO_TRACK_IDS, DEFAULT_AUDIO_LANES, LANE_DISPLAY_ORDER, assignApp, isSilent, laneLabel,
  sanitiseAudioLanes, sortLanes,
} from './audioLanes.ts'

// File order is a format: the first three never move.
assert.deepEqual([...AUDIO_TRACK_IDS], ['game', 'mic', 'other', 'discord', 'music'])
assert.deepEqual([...LANE_DISPLAY_ORDER].sort(), [...AUDIO_TRACK_IDS].sort())

assert.equal(laneLabel('game'), 'Game')
assert.equal(laneLabel('mic'), 'Mic')
assert.equal(laneLabel('discord'), 'Discord')
assert.equal(laneLabel('music'), 'Music')
assert.equal(laneLabel('other'), 'Other apps')
assert.equal(laneLabel('mystery'), 'mystery')

// A new clip's five tracks are shown Game, Mic, Discord, Music, Other.
const five = AUDIO_TRACK_IDS.map(id => ({ id }))
assert.deepEqual(sortLanes(five).map(t => t.id), ['game', 'mic', 'discord', 'music', 'other'])
// An old clip has three and gets no phantom lanes.
assert.deepEqual(sortLanes([{ id: 'game' }, { id: 'mic' }, { id: 'other' }]).map(t => t.id), ['game', 'mic', 'other'])
// An unknown track goes last and is not dropped.
assert.deepEqual(sortLanes([{ id: 'zzz' }, { id: 'mic' }]).map(t => t.id), ['mic', 'zzz'])
// sortLanes does not reorder its argument.
assert.deepEqual(five.map(t => t.id), [...AUDIO_TRACK_IDS])

assert.equal(isSilent(new Float32Array(0)), true)
assert.equal(isSilent(new Float32Array(4800)), true)
assert.equal(isSilent(Float32Array.from([0, 0.00001, -0.00001])), true)   // below hearing
const withSound = new Float32Array(4800); withSound[4000] = -0.2
assert.equal(isSilent(withSound), false)

assert.deepEqual(DEFAULT_AUDIO_LANES, { discord: ['discord.exe'], music: ['spotify.exe'] })

// Settings arrive from a file a person can edit. Junk never crashes; it is
// dropped, and a wrong shape means "use the defaults".
assert.equal(sanitiseAudioLanes('x'), undefined)
assert.equal(sanitiseAudioLanes(null), undefined)
assert.equal(sanitiseAudioLanes([]), undefined)
assert.equal(sanitiseAudioLanes({ discord: 'discord.exe', music: [] }), undefined)
assert.deepEqual(sanitiseAudioLanes({ discord: [], music: [] }), { discord: [], music: [] })   // empty is a choice
assert.deepEqual(sanitiseAudioLanes({ discord: [' Discord.EXE ', 'discord.exe', 5, null, ''], music: ['Spotify.exe'] }),
  { discord: ['discord.exe'], music: ['spotify.exe'] })
// A path is not an executable name.
assert.deepEqual(sanitiseAudioLanes({ discord: ['C:\\Apps\\Discord.exe', 'a/b.exe'], music: ['ok.exe'] }),
  { discord: [], music: ['ok.exe'] })
// An app in both lists is Discord.
assert.deepEqual(sanitiseAudioLanes({ discord: ['vlc.exe'], music: ['vlc.exe', 'spotify.exe'] }),
  { discord: ['vlc.exe'], music: ['spotify.exe'] })
// Bounded.
const many = Array.from({ length: 200 }, (_, i) => `app${i}.exe`)
assert.equal(sanitiseAudioLanes({ discord: many, music: [] })!.discord.length, 64)

// Moving an app between lanes.
const start = { discord: ['discord.exe'], music: ['spotify.exe'] }
assert.deepEqual(assignApp(start, 'VLC.exe', 'music'), { discord: ['discord.exe'], music: ['spotify.exe', 'vlc.exe'] })
assert.deepEqual(assignApp(start, 'spotify.exe', 'discord'), { discord: ['discord.exe', 'spotify.exe'], music: [] })
assert.deepEqual(assignApp(start, 'Discord.exe', 'other'), { discord: [], music: ['spotify.exe'] })
assert.deepEqual(assignApp(start, 'chrome.exe', 'other'), start)
assert.deepEqual(start, { discord: ['discord.exe'], music: ['spotify.exe'] })   // not mutated

console.log('audioLanes self-check passed')
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/apps/desktop"
node --experimental-strip-types src/shared/audioLanes.test.ts
```

Expected: FAIL, cannot find module `./audioLanes.ts`.

- [ ] **Step 3: The shared module**

Create `apps/desktop/src/shared/audioLanes.ts`:

```ts
// Audio lanes: the tracks of a clip, how they are named and ordered on screen,
// and the user's lists of which apps count as Discord and as Music.

// File order. A track is identified by its position in a clip, so this is a
// format shared with the native writer: the first three never move.
export const AUDIO_TRACK_IDS = ['game', 'mic', 'other', 'discord', 'music'] as const
export type AudioTrackId = typeof AUDIO_TRACK_IDS[number]

// The order lanes are shown in, which is not the file order: the catch-all
// reads better last.
export const LANE_DISPLAY_ORDER: readonly AudioTrackId[] = ['game', 'mic', 'discord', 'music', 'other']

const LABELS: Record<string, string> = {
  game: 'Game', mic: 'Mic', discord: 'Discord', music: 'Music', other: 'Other apps',
}
export const laneLabel = (id: string): string => LABELS[id] ?? id

// Display order for whatever tracks a clip really has. An old clip has three
// and shows three; a track this build does not know goes last.
export function sortLanes<T extends { id: string }>(tracks: readonly T[]): T[] {
  const rank = (id: string) => {
    const index = (LANE_DISPLAY_ORDER as readonly string[]).indexOf(id)
    return index < 0 ? LANE_DISPLAY_ORDER.length : index
  }
  return [...tracks].sort((a, b) => rank(a.id) - rank(b.id))
}

// A lane with nothing audible in it. Every new clip carries all five tracks,
// and most of them are empty most of the time.
export function isSilent(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) if (samples[i] > 1e-4 || samples[i] < -1e-4) return false
  return true
}

export interface AudioLanesSetting { discord: string[]; music: string[] }

export const DEFAULT_AUDIO_LANES: AudioLanesSetting = { discord: ['discord.exe'], music: ['spotify.exe'] }

const MAX_APPS = 64
// An executable name, not a path: nothing Windows forbids in a file name.
const EXE_NAME = /^[^\\/:*?"<>|]{1,128}$/

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => EXE_NAME.test(entry))
  return [...new Set(names)].slice(0, MAX_APPS)
}

// Undefined means "not usable, keep the defaults". Two empty lists are a
// legitimate choice and are kept.
export function sanitiseAudioLanes(value: unknown): AudioLanesSetting | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const discord = cleanList(source.discord)
  const music = cleanList(source.music)
  if (!discord || !music) return undefined
  // In both lists counts as Discord, the same rule the capture engine applies.
  return { discord, music: music.filter(exe => !discord.includes(exe)) }
}

// The lists after moving one app. "other" removes it from both.
export function assignApp(lanes: AudioLanesSetting, exe: string, lane: 'discord' | 'music' | 'other'): AudioLanesSetting {
  const name = exe.trim().toLowerCase()
  const without = (list: string[]) => list.filter(entry => entry !== name)
  const next: AudioLanesSetting = { discord: without(lanes.discord), music: without(lanes.music) }
  if (lane !== 'other') next[lane] = [...next[lane], name]
  return next
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/apps/desktop"
node --experimental-strip-types src/shared/audioLanes.test.ts
```

Expected: `audioLanes self-check passed`.

- [ ] **Step 5: Settings plumbing**

`apps/desktop/src/shared/sanitise.ts`: add `import { sanitiseAudioLanes } from './audioLanes.ts'` at the top, and inside the `for` loop, next to the `ignoredGames` block, add:

```ts
    if (key === 'audioLanes') {
      const lanes = sanitiseAudioLanes(value)
      if (lanes) clean[key] = lanes
      continue
    }
```

`apps/desktop/src/main/main.ts`:

- Import: `import { DEFAULT_AUDIO_LANES, type AudioLanesSetting, type AudioTrackId } from '../shared/audioLanes'` (match the neighbouring shared imports' style).
- In `DEFAULTS`, after `audioCapture: true,` add `audioLanes: DEFAULT_AUDIO_LANES as AudioLanesSetting,`.
- In the addon interface (`CaptureAddon`): change `setAudioTracks?` to take `Record<AudioTrackId, boolean>`; add `setAudioLanes?(lanes: AudioLanesSetting): void`, `listAudioApps?(): { exe: string; name: string; lane: string; pid: number; capturing: boolean }[]`, and `capabilities?: { smartRender?: boolean; perAppAudio?: boolean }` (if a `capabilities` field is already declared, add `perAppAudio?: boolean` to it). Change both `gains?: { game?: number; mic?: number; other?: number }` declarations in this file to `gains?: Partial<Record<AudioTrackId, number>>`.
- Replace the body of `applyAudioCapture` so it covers five lanes, and add its sibling below it:

```ts
function applyAudioCapture() {
  const on = settings.audioCapture
  try { captureAddon?.setAudioTracks?.({ game: on, mic: on, other: on, discord: on, music: on }) }
  catch (error) { console.warn('Could not apply audio capture setting', error) }
}

// Which apps are recorded to the Discord and Music lanes. Applied to the
// running capture; nothing needs restarting and saved clips are not touched.
function applyAudioLanes() {
  try { captureAddon?.setAudioLanes?.(settings.audioLanes) }
  catch (error) { console.warn('Could not apply audio lanes', error) }
}
```

- Call `applyAudioLanes()` immediately before every existing call to `applyAudioCapture()` that runs at startup (there is one near the end of the file), and in the `set-settings` handler add, next to `if (changed.audioCapture !== undefined) applyAudioCapture()`: `if (changed.audioLanes !== undefined) applyAudioLanes()`.
- Add an IPC handler next to `get-learned-games`:

```ts
  // What the Settings picker shows: apps that have an audio session right now,
  // and which lane each is recorded to.
  ipcMain.handle('list-audio-apps', () => {
    const supported = captureAddon?.capabilities?.perAppAudio === true
    if (!supported) return { supported: false, apps: [] }
    try {
      const apps = captureAddon?.listAudioApps?.() ?? []
      return { supported: true, apps: apps.map(({ exe, name, lane, capturing }) => ({ exe, name, lane, capturing })) }
    } catch (error) {
      console.warn('Could not list audio apps', error)
      return { supported: true, apps: [] }
    }
  })
```

`apps/desktop/src/preload/preload.ts`:

- Add `audioLanes: { discord: string[]; music: string[] }` to the exported `Settings` interface, after `audioCapture`.
- Change both `gains?: { game?: number; mic?: number; other?: number }` to `gains?: Partial<Record<'game' | 'mic' | 'other' | 'discord' | 'music', number>>`.
- Add to the API object: `listAudioApps: () => ipcRenderer.invoke('list-audio-apps'),` and to its type: `listAudioApps: () => Promise<{ supported: boolean; apps: { exe: string; name: string; lane: string; capturing: boolean }[] }>`.

- [ ] **Step 6: Settings picker**

`apps/desktop/src/renderer/SettingsView.tsx`:

- Add `audioLanes: { discord: string[]; music: string[] }` to its local settings interface after `audioCapture`.
- Import `assignApp, laneLabel` from `'../shared/audioLanes'`.
- Add a component above the main view (the file already has `Row`, `Status` and `Dropdown` in scope; import `Dropdown` from `'./Dropdown'` if it is not):

```tsx
type AudioApp = { exe: string; name: string; lane: string; capturing: boolean }

// Which apps are recorded to the Discord and Music lanes. Lists what is making
// sound now, then anything assigned that is not running, so an assignment can
// be undone without starting the app.
function AppAudio({ lanes, onChange }: {
  lanes: { discord: string[]; music: string[] }
  onChange: (next: { discord: string[]; music: string[] }) => void
}) {
  const [state, setState] = useState<{ supported: boolean; apps: AudioApp[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = () => window.flash.listAudioApps().then(result => { if (!cancelled) setState(result) }).catch(() => {})
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  if (!state) return null
  if (!state.supported) {
    return (
      <Row label="App audio" hint={window.flash.platform === 'linux'
        ? 'Per-app audio is not available on Linux yet. Desktop sound is recorded to Other apps.'
        : 'Per-app audio is not available on this version of Windows. Desktop sound is recorded to one track.'}>
        <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>Not available</span>
      </Row>
    )
  }

  const running = new Set(state.apps.map(app => app.exe.toLowerCase()))
  const assignedOnly = [...lanes.discord.map(exe => ({ exe, lane: 'discord' })), ...lanes.music.map(exe => ({ exe, lane: 'music' }))]
    .filter(entry => !running.has(entry.exe))
  const choices = [
    { value: 'discord', label: laneLabel('discord') },
    { value: 'music', label: laneLabel('music') },
    { value: 'other', label: laneLabel('other') },
  ]
  // The list is the source of truth for the control, so a change shows at once
  // rather than after the capture engine's next two-second scan.
  const laneOf = (exe: string) => {
    const name = exe.toLowerCase()
    return lanes.discord.includes(name) ? 'discord' : lanes.music.includes(name) ? 'music' : 'other'
  }

  return (
    <Row label="App audio" hint="Choose which apps are recorded to the Discord and Music lanes. Everything else goes to Other apps.">
      <div className="flex flex-col gap-2" style={{ minWidth: 300 }}>
        {state.apps.length === 0 && assignedOnly.length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>No apps are making sound right now.</span>
        )}
        {state.apps.map(app => (
          <div key={app.exe} className="flex items-center gap-3">
            <span className="flex-1 truncate" style={{ fontSize: 12, color: 'var(--fg)' }} title={app.exe}>
              {app.name}
            </span>
            {app.lane === 'game'
              ? <span style={{ fontSize: 12, color: 'var(--muted-2)', width: 132 }}>{laneLabel('game')}</span>
              : <Dropdown value={laneOf(app.exe)} options={choices} width={132} title={`Lane for ${app.name}`}
                  onChange={lane => onChange(assignApp(lanes, app.exe, lane as 'discord' | 'music' | 'other'))} />}
          </div>
        ))}
        {assignedOnly.map(entry => (
          <div key={entry.exe} className="flex items-center gap-3">
            <span className="flex-1 truncate" style={{ fontSize: 12, color: 'var(--muted-2)' }}>
              {entry.exe} <span style={{ color: 'var(--muted-3)' }}>· not running · {laneLabel(entry.lane)}</span>
            </span>
            <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${entry.exe}`}
              onClick={() => onChange(assignApp(lanes, entry.exe, 'other'))}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </Row>
  )
}
```

- Render it directly after the existing "Record audio" `Row`:

```tsx
            {settings.audioCapture && (
              <AppAudio lanes={settings.audioLanes} onChange={audioLanes => onChange({ audioLanes })} />
            )}
```

- Change the "Record audio" hint from `"Game, system and microphone, each on its own track."` to `"Game, microphone, Discord, music and other apps, each on its own track."`.

Make sure `useState` and `useEffect` are imported in this file. If `onChange`'s parameter type is a `Partial` of the local settings interface, the new key type-checks without further change.

- [ ] **Step 7: Editor lanes**

`apps/desktop/src/renderer/editor/useClipAudio.ts`: import `sortLanes` from `'../../shared/audioLanes'` and change the line that stores the tracks to `setTracks(sortLanes(result.tracks.map(track => ({ ...track, sampleRate: result.sampleRate }))))`. The editor and the Watch view both read from this hook, so both get display order.

`apps/desktop/src/renderer/editor/AudioLanes.tsx`:

- Import `LANE_DISPLAY_ORDER, isSilent, laneLabel` from `'../../shared/audioLanes'` and `useMemo` from React.
- Replace `const EXPECTED_TRACKS = ['game', 'mic', 'other'] as const` with `const EXPECTED_TRACKS = LANE_DISPLAY_ORDER`.
- In `TrackIcon`, add two cases before the final (game controller) return:

```tsx
  if (id === 'discord') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 9.5v-2a5.5 5.5 0 0111 0v2" />
        <rect x="1.5" y="9" width="3" height="4.5" rx="1" />
        <rect x="11.5" y="9" width="3" height="4.5" rx="1" />
      </svg>
    )
  }
  if (id === 'music') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 12V3.5l7-1.5v8.5" />
        <circle cx="4.2" cy="12" r="1.8" />
        <circle cx="11.2" cy="10.5" r="1.8" />
      </svg>
    )
  }
```

- In the skeleton (loading) block, show `{laneLabel(id)}` instead of `{id}`.
- In the main list: compute silence once per decode, above the `return`:

```tsx
  // Every new clip carries all five tracks and most are empty. An empty lane
  // is shown, so the layout does not jump between clips, but it is dimmed and
  // its controls are off: there is nothing in it to mute or boost.
  const silent = useMemo(() => new Set(tracks.filter(track => isSilent(track.samples)).map(track => track.id)), [tracks])
```

  (`useMemo` must run before the two early returns; hooks cannot follow a conditional return. Place it at the top of the component.)

  then change `const disabled = track.samples.length === 0` to `const disabled = track.samples.length === 0 || silent.has(track.id)`, replace the three `aria-label`s' `${track.id}` with `${laneLabel(track.id)}`, show `{laneLabel(track.id)}` in the caption, and render the waveform column as:

```tsx
            {silent.has(track.id) && track.samples.length > 0
              ? <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>no sound</span>
              : <Waveform track={track} />}
```

- `LANE_GRID`'s second column is `54px`, sized for "OTHER". "OTHER APPS" in the caps style needs more: change `'32px 54px minmax(60px, 1fr) 88px 42px'` to `'32px 84px minmax(60px, 1fr) 88px 42px'`.

`Editor.tsx` needs no change: it builds gains and mutes from `audioTracks` by id, and a muted or silent lane's gain is simply sent as given.

- [ ] **Step 8: Typecheck and test**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm typecheck && pnpm test
```

Expected: no type errors; `audioLanes.test.ts` listed as `pass`; `all checks passed`.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/shared/audioLanes.ts apps/desktop/src/shared/audioLanes.test.ts apps/desktop/src/shared/sanitise.ts apps/desktop/src/main/main.ts apps/desktop/src/preload/preload.ts apps/desktop/src/renderer/SettingsView.tsx apps/desktop/src/renderer/editor/AudioLanes.tsx apps/desktop/src/renderer/editor/useClipAudio.ts
git commit -m "feat(audio): app picker in Settings and five named lanes in the editor"
```

---

### Task 6: Acceptance

**Files:**
- Modify: `docs/linux.md` (audio row, L2 list)

**Interfaces:**
- Consumes: everything above.
- Produces: evidence, a green CI run on both platforms, and the Linux documentation.

- [ ] **Step 1: Linux documentation**

In `docs/linux.md`, in the "Current state" table replace the Audio row with:

```
| Audio | Default sink monitor and default microphone, 48 kHz stereo float; desktop audio uses the `other` lane. Clips and exports understand all five lanes (game, mic, other, discord, music), but per-app capture is Windows-only for now: `capabilities.perAppAudio` is false and Settings says so | Timing, default-device changes, PipeWire routing and permissions; per-app capture |
```

and append to the **L2** item in "Next phases", before its final sentence:

```
 Implement per-app audio through PipeWire (one capture stream per application node, routed by the shared lane rule into the shared lane mixer) and check it on each distro family, including Flatpak apps, whose process names are hidden behind the sandbox.
```

```bash
git add docs/linux.md
git commit -m "docs(linux): five audio lanes, per-app capture still to do"
```

- [ ] **Step 2: The running app**

The installed Flash holds the hotkeys and a single-instance lock, so the dev build exits silently while it runs. Stop it (`Stop-Process -Name Flash -Force` in PowerShell), start the dev build from `apps/desktop` with `npx electron-vite dev --remoteDebuggingPort 9229 -- --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows`, and drive it over the Chrome DevTools Protocol from a scratch script outside the repo (Node 24 has global `fetch` and `WebSocket`; `http://127.0.0.1:9229/json` lists the page). When finished, in every outcome, stop the dev build and start `C:\Program Files\Flash\Flash.exe` again. Never modify the install folder.

Check and record the evidence for each:

A. `await window.flash.listAudioApps()` returns `supported: true`, and with Spotify and Discord running lists them with lanes `music` and `discord`.
B. Settings shows the "App audio" row under "Record audio" with those apps; no label is cut off (compare `scrollWidth` and `clientWidth`); changing an app's lane through `window.flash.setSettings({ audioLanes: ... })` is reflected by `listAudioApps()` within 3 seconds; restore the original lists afterwards and confirm `getSettings()` matches what it was.
C. Save a clip through the app while Spotify is playing (`window.flash` has the save call the hotkey uses; find it in `preload.ts`). `decodeClipAudio` on it returns five tracks in display order game, mic, discord, music, other, with `music` audible and `discord` and `game` silent. Open it in the editor and confirm five lanes labelled Game, Mic, Discord, Music, Other apps, the silent ones showing "no sound" with disabled controls. Take one screenshot of the lanes.
D. An old clip (`C:\Users\emers\Videos\Flash\Minecraft (Java)\2026-09-29_15-31-37.mp4`) opens with exactly three lanes: Game, Mic, Other apps.
E. Export the new clip at 10MB with the Music lane muted in the editor's save path (`saveClipEdit` with `gains: { music: 0 }`, `reEncode: true`) and confirm with the tone-free method available: the saved file's single mixed track is quieter than the same save with `gains: {}` while Spotify was the only sound. Delete every file this step created, and their `.json` sidecars.

- [ ] **Step 3: CI on both platforms**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
git push -u origin audio-lanes
gh run list --branch audio-lanes --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch <id> --exit-status
```

Expected: both jobs succeed. The Ubuntu job is the only compile of the Linux edits from Task 1 and the only Linux run of the three core tests. If it fails, read `gh run view <id> --log-failed`, fix, commit, push and watch again; record each failure and fix.

- [ ] **Step 4: Hand off**

Report with measured numbers: the probe output from Task 4, the results of A to E, the CI run id and result, and what is not verified (Linux at runtime; a real game with a real Discord call; more than a handful of apps at once). The user's own check is to record a clip with Spotify playing and Discord making sound, open it in the editor, and mute Music, then Discord. Do not call the work finished before the user has done that.
