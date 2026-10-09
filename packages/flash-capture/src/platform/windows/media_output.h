#pragma once

#ifdef _WIN32
#include <Windows.h>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <stdexcept>

namespace flash {

// Publish only a finished file. MoveFileW refuses an existing destination, even
// if another caller created it after the main process reserved the name.
class MediaOutput {
public:
    explicit MediaOutput(const std::filesystem::path& destination) : destination_(destination) {
        if (std::filesystem::exists(destination_)) throw std::runtime_error("output file already exists");
        if (!destination_.parent_path().empty()) std::filesystem::create_directories(destination_.parent_path());
        static std::atomic<uint64_t> next{0};
        for (;;) {
            partial_ = destination_.parent_path() / (destination_.stem().wstring() + L"." +
                std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(next++) + L".partial" + destination_.extension().wstring());
            HANDLE file = CreateFileW(partial_.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); break; }
            if (GetLastError() != ERROR_FILE_EXISTS) throw std::runtime_error("could not reserve temporary output file");
        }
    }
    ~MediaOutput() {
        std::error_code ignored;
        std::filesystem::remove(partial_, ignored);
    }
    MediaOutput(const MediaOutput&) = delete;
    MediaOutput& operator=(const MediaOutput&) = delete;
    const std::filesystem::path& Partial() const { return partial_; }
    void Publish() {
        if (!MoveFileW(partial_.c_str(), destination_.c_str()))
            throw std::runtime_error("could not publish output; destination may already exist");
    }
private:
    std::filesystem::path destination_, partial_;
};

} // namespace flash
#endif
