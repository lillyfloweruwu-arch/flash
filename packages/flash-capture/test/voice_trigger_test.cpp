#include "../src/capture/voice_trigger.h"

#include <cassert>
#include <chrono>
#include <cstdio>

using flash::VoiceTriggerGate;

int main() {
    VoiceTriggerGate gate;
    const auto start = VoiceTriggerGate::Clock::time_point{};

    // Set explicitly rather than leaning on the default. The default is a
    // tuning value that moves when real calibration data says it should - it
    // already moved once - and a logic test that fails because a threshold was
    // tuned is testing the wrong thing.
    gate.SetThreshold(0.5, 3000);

    assert(!gate.Accept(0.499, start));
    assert(gate.Accept(0.5, start));
    // Cooldown: a second match inside the window is ignored however confident.
    assert(!gate.Accept(1.0, start + std::chrono::milliseconds(2999)));
    assert(gate.Accept(0.75, start + std::chrono::milliseconds(3000)));

    gate.SetThreshold(0.8, 0);
    assert(!gate.Accept(0.79, start + std::chrono::milliseconds(3001)));
    assert(gate.Accept(0.8, start + std::chrono::milliseconds(3001)));

    std::puts("voice trigger gate checks passed");
    return 0;
}
