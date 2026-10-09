#pragma once

#include <cstdint>
#include <memory>

#ifdef _WIN32

struct ID3D11Device;
struct ID3D11Texture2D;

namespace flash {

struct SourceFrame {
    ID3D11Texture2D* texture;
    int64_t timestampUs;
};

class FrameSource {
public:
    virtual ~FrameSource() = default;

    virtual bool Start(uint32_t displayId, uint32_t fps) = 0;
    virtual bool Next(SourceFrame& frame, uint32_t timeoutMs) = 0;
    virtual void Stop() = 0;
    virtual const char* Name() const = 0;

    // Valid only after a successful Start. The caller sizes its conversion
    // resources from these, so a backend must know them before its first frame.
    virtual uint32_t Width() const = 0;
    virtual uint32_t Height() const = 0;

    // Non-null once the backend has failed for good — the captured monitor was
    // unplugged, the session was closed under it. Distinct from Next()
    // returning false, which only means no new frame this tick. The caller has
    // to stop rather than keep recording, because both backends re-deliver
    // their last frame on an empty tick: without this a dead source records a
    // frozen image and reports itself healthy the whole time.
    virtual const char* Failure() const { return nullptr; }
};

// Returns null when Windows.Graphics.Capture is unavailable, so the caller can
// fall back to Desktop Duplication rather than failing to start.
//
// The device is passed here rather than through FrameSource::Start because the
// capture frame pool must be built on the same D3D11 device the encoder already
// shares - otherwise every frame costs a cross-device copy. Keeping it out of
// the interface leaves that interface free of any backend's types.
std::unique_ptr<FrameSource> CreateWgcSource(ID3D11Device* device);

} // namespace flash

#endif
