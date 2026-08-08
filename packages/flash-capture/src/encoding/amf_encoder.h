#pragma once

#include "encoder.h"

namespace flash {

class AmfEncoder : public Encoder {
public:
    AmfEncoder();
    ~AmfEncoder() override;

    bool Initialize(const EncoderConfig& config) override;
    bool EncodeFrame(const FrameData& frame, EncodedPacket& output) override;
    void Flush() override;
    std::string GetName() const override { return "AMF H.264"; }
    bool IsHardwareAccelerated() const override { return true; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace flash
