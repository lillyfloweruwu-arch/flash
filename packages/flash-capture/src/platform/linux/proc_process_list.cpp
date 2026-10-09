// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include <filesystem>
#include <fstream>
#include <sstream>
#include <regex>
#include <algorithm>

namespace flash {
namespace {
std::string Read(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
class ProcProcesses final : public ProcessLister {
public:
    ProcessSnapshot List() override {
        // L1: /proc races and restricted mounts need a real desktop check in L2.
        ProcessSnapshot snapshot;
        std::error_code error;
        for (const auto& entry : std::filesystem::directory_iterator("/proc", error)) {
            const auto name = entry.path().filename().string();
            if (name.empty() || name.find_first_not_of("0123456789") != std::string::npos) continue;
            try {
                ProcessInfo process; process.pid = std::stoul(name);
                process.path = std::filesystem::read_symlink(entry.path() / "exe", error).string();
                process.exe = std::filesystem::path(process.path).filename().string();
                if (process.exe.empty()) { process.exe = Read(entry.path() / "comm"); if (!process.exe.empty() && process.exe.back() == '\n') process.exe.pop_back(); }
                if (process.exe.empty()) continue;
                process.cmdline = Read(entry.path() / "cmdline");
                if (std::regex_match(process.exe, std::regex("wine(64)?(-preloader)?"))) {
                    std::istringstream arguments(process.cmdline); std::string argument;
                    while (std::getline(arguments, argument, '\0')) {
                        const auto name = argument.substr(argument.find_last_of("/\\") + 1);
                        if (name.size() > 4 && name.substr(name.size() - 4) == ".exe" && name != "steam.exe" && name != "steamwebhelper.exe") { process.exe = name; break; }
                    }
                }
                std::replace(process.cmdline.begin(), process.cmdline.end(), '\0', ' ');
                const auto stat = Read(entry.path() / "stat");
                std::istringstream fields(stat.substr(stat.rfind(')') + 2));
                std::string field;
                for (int i = 0; fields >> field; ++i) {
                    if (i == 1) process.parentPid = std::stoul(field);
                    if (i == 19) process.startTicks = std::stoll(field);
                }
                std::smatch match;
                const auto status = Read(entry.path() / "status");
                if (std::regex_search(status, match, std::regex("VmRSS:\\s+(\\d+)"))) process.workingSet = std::stoull(match[1]) * 1024;
                const auto environment = Read(entry.path() / "environ");
                size_t start = 0;
                while (start < environment.size()) {
                    const auto end = environment.find('\0', start); const auto item = environment.substr(start, end - start);
                    for (const std::string prefix : {"SteamAppId=", "STEAM_COMPAT_APP_ID="}) {
                        if (item.rfind(prefix, 0) == 0) {
                            const auto id = item.substr(prefix.size());
                            if (!id.empty() && id[0] != '0' && id.find_first_not_of("0123456789") == std::string::npos) process.steamAppId = id;
                        }
                    }
                    if (end == std::string::npos) break;
                    start = end + 1;
                }
                if (process.steamAppId.empty() && std::regex_search(process.cmdline, match, std::regex("/compatdata/([1-9][0-9]*)(/| |$)"))) process.steamAppId = match[1];
                snapshot.processes.push_back(std::move(process));
            } catch (const std::exception&) { /* A process may disappear between reads. */ }
        }
        return snapshot;
    }
};
}
std::unique_ptr<ProcessLister> CreateProcessLister() { return std::make_unique<ProcProcesses>(); }
} // namespace flash
