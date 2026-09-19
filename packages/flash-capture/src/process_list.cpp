#include "process_list.h"

#ifdef _WIN32
#include <Windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <unordered_map>
#pragma comment(lib, "psapi.lib")
#endif

namespace flash {

#ifdef _WIN32
namespace {

std::string Narrow(const wchar_t* text) {
    if (!text || !*text) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (size <= 1) return {};
    std::string result(static_cast<size_t>(size) - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), size, nullptr, nullptr);
    return result;
}

using TitlesByPid = std::unordered_map<uint32_t, std::string>;

BOOL CALLBACK CollectWindow(HWND window, LPARAM param) {
    if (!IsWindowVisible(window)) return TRUE;
    // An owned window is a dialog or a tool window, never the app's main one.
    if (GetWindow(window, GW_OWNER)) return TRUE;
    const int length = GetWindowTextLengthW(window);
    if (length <= 0) return TRUE;

    std::wstring title(static_cast<size_t>(length) + 1, L'\0');
    const int written = GetWindowTextW(window, title.data(), length + 1);
    if (written <= 0) return TRUE;
    title.resize(static_cast<size_t>(written));

    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (!pid) return TRUE;

    // First titled top-level window wins. A game has exactly one that matters,
    // and emplace leaves an already-recorded title alone.
    reinterpret_cast<TitlesByPid*>(param)->emplace(static_cast<uint32_t>(pid), Narrow(title.c_str()));
    return TRUE;
}

}  // namespace
#endif

ProcessSnapshot ListProcesses() {
    ProcessSnapshot snapshot;
#ifdef _WIN32
    TitlesByPid titles;
    EnumWindows(CollectWindow, reinterpret_cast<LPARAM>(&titles));

    DWORD foreground = 0;
    if (HWND window = GetForegroundWindow()) GetWindowThreadProcessId(window, &foreground);
    snapshot.foregroundPid = static_cast<uint32_t>(foreground);

    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return snapshot;

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snap, &entry)) {
        do {
            ProcessInfo info;
            info.pid = static_cast<uint32_t>(entry.th32ProcessID);
            info.exe = Narrow(entry.szExeFile);
            if (const auto found = titles.find(info.pid); found != titles.end()) {
                info.windowTitle = found->second;
            }

            // PROCESS_QUERY_LIMITED_INFORMATION is the right an ordinary user
            // actually has over other processes; the older
            // PROCESS_QUERY_INFORMATION is refused for most of them, which is
            // why the path and memory come back empty rather than failing.
            if (HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID)) {
                wchar_t path[MAX_PATH * 2];
                DWORD size = MAX_PATH * 2;
                if (QueryFullProcessImageNameW(process, 0, path, &size)) info.path = Narrow(path);

                FILETIME created{}, exited{}, kernel{}, user{};
                if (GetProcessTimes(process, &created, &exited, &kernel, &user)) {
                    info.startTicks = (static_cast<int64_t>(created.dwHighDateTime) << 32) |
                        static_cast<int64_t>(created.dwLowDateTime);
                }

                PROCESS_MEMORY_COUNTERS memory{};
                memory.cb = sizeof(memory);
                if (GetProcessMemoryInfo(process, &memory, sizeof(memory))) {
                    info.workingSet = memory.WorkingSetSize;
                }
                CloseHandle(process);
            }

            snapshot.processes.push_back(std::move(info));
        } while (Process32NextW(snap, &entry));
    }
    CloseHandle(snap);
#endif
    return snapshot;
}

}  // namespace flash
