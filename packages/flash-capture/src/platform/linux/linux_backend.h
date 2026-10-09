#pragma once
#include "../../core/platform.h"
#include <atomic>
#include <gio/gio.h>

namespace flash {
// L1 scaffolding: none of this backend has been run on Linux hardware yet.
class PortalSession {
public:
    PortalSession() = default;
    ~PortalSession();
    PortalSession(const PortalSession&) = delete;
    PortalSession& operator=(const PortalSession&) = delete;
    void Open(GCancellable* cancel);
    int TakeFd();
    uint32_t node = 0;
    std::string serial;
private:
    GDBusConnection* bus_ = nullptr;
    std::string session_;
    int fd_ = -1;
};
std::shared_ptr<VideoSource> CreatePipeWireVideo();
std::unique_ptr<AudioSource> CreatePipeWireAudio();
std::unique_ptr<ClipMuxer> CreateLibavMuxer();
void CheckLibavLicense();
void WriteLinuxPng(const std::string& path, const FrameData& frame);
} // namespace flash
