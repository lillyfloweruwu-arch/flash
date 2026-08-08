#pragma once

#include "encoder.h"

namespace flash {

// Software fallback encoder using Media Foundation H.264 encoder
// Available on all Windows 10+ machines — no GPU SDK needed
class SoftwareEncoder : public Encoder {
public:
    SoftwareEncoder();
    ~SoftwareEncoder() override;

    bool Initialize(const EncoderConfig& config) override;
    bool EncodeFrame(const FrameData& frame, std::vector<EncodedPacket>& output) override;
    void Flush() override;
    std::string GetName() const override { return "Software H.264 (Media Foundation)"; }
    bool IsHardwareAccelerated() const override { return false; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace flash
