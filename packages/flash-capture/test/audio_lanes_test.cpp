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

    // A pid is inside its own tree even when the snapshot missed it.
    assert(IsInProcessTree(4242, 4242, {}));
    assert(IsInProcessTree(4242, 4242, all));
    assert(!IsInProcessTree(0, 0, all));

    // Descendants win: a tree capture cannot leave a subtree out, so an app with
    // the game, or another captured app, beneath it is not captured itself.
    std::vector<ProcessInfo> steam{
        Proc(10, 4, "explorer.exe", 1),
        Proc(400, 10, "steam.exe", 40),
        Proc(401, 400, "steam.exe", 41),               // its own same-named child
        Proc(402, 400, "RocketLeague.exe", 42),        // the game it launched
        Proc(500, 10, "chrome.exe", 50),
        Proc(501, 500, "chrome.exe", 51),
        Proc(600, 10, "a.exe", 60), Proc(601, 600, "b.exe", 61), Proc(602, 601, "c.exe", 62),
    };
    assert(HasCapturedDescendant(400, {400}, 402, steam));          // the game runs beneath it
    assert(HasCapturedDescendant(400, {400, 402}, 0, steam));       // another captured app runs beneath it
    assert(!HasCapturedDescendant(400, {400}, 0, steam));           // only its own children
    assert(!HasCapturedDescendant(500, {500, 400}, 402, steam));    // unrelated apps and game
    assert(!HasCapturedDescendant(400, {400}, 400, steam));         // the game is the root itself
    assert(!HasCapturedDescendant(402, {402, 400}, 402, steam));    // the game is not above itself
    assert(HasCapturedDescendant(600, {600, 601, 602}, 0, steam));
    assert(HasCapturedDescendant(601, {600, 601, 602}, 0, steam));
    assert(!HasCapturedDescendant(602, {600, 601, 602}, 0, steam));

    std::puts("audio lanes self-check passed");
    return 0;
}
