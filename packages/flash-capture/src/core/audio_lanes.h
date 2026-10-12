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
