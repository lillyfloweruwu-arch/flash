#include "../src/capture/voice_trigger.h"

#include <cassert>
#include <chrono>
#include <cstdio>

using flash::VoiceTriggerGate;

int main() {
    VoiceTriggerGate gate;
    const auto start = VoiceTriggerGate::Clock::time_point{};

    assert(!gate.Accept(0.499, start));
    assert(gate.Accept(0.5, start));
    assert(!gate.Accept(1.0, start + std::chrono::milliseconds(2999)));
    assert(gate.Accept(0.75, start + std::chrono::milliseconds(3000)));

    gate.SetThreshold(0.8, 0);
    assert(!gate.Accept(0.79, start + std::chrono::milliseconds(3001)));
    assert(gate.Accept(0.8, start + std::chrono::milliseconds(3001)));

    std::puts("voice trigger gate checks passed");
    return 0;
}
