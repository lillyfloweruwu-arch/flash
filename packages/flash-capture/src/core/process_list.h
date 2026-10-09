#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace flash {

struct ProcessInfo {
    uint32_t pid = 0, parentPid = 0;
    std::string cmdline, steamAppId;
    std::string exe;          // "game.exe", always present
    std::string path;         // full image path, empty when it cannot be read
    std::string windowTitle;  // title of its visible top-level window, empty if none
    uint64_t workingSet = 0;  // bytes, 0 when it cannot be read
    int64_t startTicks = 0;   // Platform creation ticks, used only to order launches.
};

struct ProcessSnapshot {
    std::vector<ProcessInfo> processes;
    uint32_t foregroundPid = 0;  // owner of the focused window, 0 if none
};

class ProcessLister {
public:
    virtual ~ProcessLister() = default;
    virtual ProcessSnapshot List() = 0;
};

// Everything game detection needs, in one pass.
//
// This replaces three child processes that ran every three seconds for the life
// of the app: `tasklist` for the known-game match, and two PowerShell scripts —
// one to guess an unrecognised game from window titles and memory, one to find
// the focused window and process start times. Measured on this machine, tasklist
// alone took 648ms and the PowerShell scan 627ms, so an idle Flash spent roughly
// 40% of a core doing nothing but asking what is running.
ProcessSnapshot ListProcesses();

}  // namespace flash
