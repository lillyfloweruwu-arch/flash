#pragma once
#include "../../core/encoder.h"

namespace flash {

class MfHardwareEncoder final : public Encoder {
public:
    MfHardwareEncoder();
    ~MfHardwareEncoder() override;
    bool Initialize(const EncoderConfig& config) override;
    bool EncodeFrame(const FrameData& frame, std::vector<EncodedPacket>& output) override;
    void Flush() override;
    std::string GetName() const override;
    bool IsHardwareAccelerated() const override { return true; }
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace flash
