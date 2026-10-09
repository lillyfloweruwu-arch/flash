#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace flash {

struct VoiceStatus {
    bool available = false;
    std::string language;
    std::string error;
};

// Kept independent of WinRT so the confidence and cooldown policy can be
// checked without a microphone or speech language pack.
class VoiceTriggerGate {
public:
    using Clock = std::chrono::steady_clock;

    void SetThreshold(double rawFloor, uint32_t cooldownMs) {
        rawFloor_ = rawFloor;
        cooldown_ = std::chrono::milliseconds(cooldownMs);
    }

    bool Accept(double rawConfidence, Clock::time_point now) {
        if (rawConfidence < rawFloor_) return false;
        if (hasTriggered_ && now - lastTrigger_ < cooldown_) return false;
        hasTriggered_ = true;
        lastTrigger_ = now;
        return true;
    }

private:
    // Calibration placeholders, not measured accuracy values.
    // Only a fallback: the app sets this from its own setting at startup. Kept
    // in step with that setting's default, which was measured rather than
    // picked - see the note beside voiceRawFloor in main.ts.
    double rawFloor_ = 0.30;
    std::chrono::milliseconds cooldown_{3000};
    bool hasTriggered_ = false;
    Clock::time_point lastTrigger_{};
};

class VoiceTrigger {
public:
    using CommandCallback = std::function<void(const std::string&, double)>;

    VoiceTrigger();
    ~VoiceTrigger();

    VoiceTrigger(const VoiceTrigger&) = delete;
    VoiceTrigger& operator=(const VoiceTrigger&) = delete;

    void SetEnabled(bool enabled) noexcept;
    bool SetPhrases(const std::vector<std::string>& phrases) noexcept;
    void SetThreshold(double rawFloor, uint32_t cooldownMs) noexcept;
    VoiceStatus GetStatus() const noexcept;
    void SetCallback(CommandCallback callback) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace flash
