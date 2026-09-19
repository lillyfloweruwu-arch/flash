// Self-check for the native process list. It asserts against this very process,
// which is the one thing about the machine that is guaranteed to be true, and
// then reports what it could read about everything else — permissions and
// window ownership are facts about the machine, not defects.
#include "../src/process_list.h"

#include <cassert>
#include <chrono>
#include <cstdio>
#include <string>

#ifdef _WIN32
#include <Windows.h>
#endif

int main() {
    const flash::ProcessSnapshot snapshot = flash::ListProcesses();

#ifdef _WIN32
    assert(!snapshot.processes.empty() && "no processes at all means the snapshot failed");

    const uint32_t self = static_cast<uint32_t>(GetCurrentProcessId());
    const flash::ProcessInfo* mine = nullptr;
    for (const auto& process : snapshot.processes) if (process.pid == self) mine = &process;

    assert(mine && "this process is missing from its own process list");
    assert(!mine->exe.empty() && "every entry must carry an executable name");
    assert(mine->exe.find(".exe") != std::string::npos);
    // The three fields that need a handle. They are allowed to be empty for
    // another user's processes, never for this one.
    assert(!mine->path.empty() && "own image path should always be readable");
    assert(mine->workingSet > 0 && "own working set should always be readable");
    assert(mine->startTicks > 0 && "own start time should always be readable");

    // Detection matches on the executable name, so a duplicate pid would make
    // one game shadow another.
    for (size_t i = 0; i < snapshot.processes.size(); ++i) {
        for (size_t j = i + 1; j < snapshot.processes.size(); ++j) {
            assert(snapshot.processes[i].pid != snapshot.processes[j].pid && "duplicate pid");
        }
    }

    // The unknown-game guess is driven entirely by these three, so a run where
    // none of them ever comes back would silently stop detecting new games.
    size_t withPath = 0, withMemory = 0, withTitle = 0;
    for (const auto& process : snapshot.processes) {
        if (!process.path.empty()) ++withPath;
        if (process.workingSet > 0) ++withMemory;
        if (!process.windowTitle.empty()) ++withTitle;
    }
    assert(withPath > 1 && "no process paths readable at all");
    assert(withMemory > 1 && "no working sets readable at all");

    // The point of this replacing tasklist and two PowerShell scripts is that it
    // is cheap enough to run every few seconds forever, so the cost is part of
    // the check rather than a claim in a commit message. Those three cost about
    // 1.3 seconds of process work between them, every poll.
    const auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < 5; ++i) (void)flash::ListProcesses();
    const auto perCall = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - start).count() / 5;
    assert(perCall < 250000 && "a poll this slow would be no better than tasklist");

    std::printf("process list self-check passed: %zu processes, %zu with a path, "
                "%zu with memory, %zu with a window title, foreground pid %u, %lldus per call\n",
                snapshot.processes.size(), withPath, withMemory, withTitle, snapshot.foregroundPid,
                static_cast<long long>(perCall));
#else
    (void)snapshot;
    std::printf("process list self-check skipped: not Windows\n");
#endif
    return 0;
}
