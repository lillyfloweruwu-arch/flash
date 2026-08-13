// Voice calibration harness. Not a self-check - it is a measuring tool, run by
// hand with a microphone and a human voice.
//
// It exists because the confidence floor in the voice-activation design is the
// difference between a feature that fires when you ask and one that fires while
// you talk to your friends, and that number cannot be chosen from a desk. Run
// this twice:
//
//   1. Say the trigger phrases deliberately, a dozen times each. Every match is
//      logged with its raw confidence. The floor goes just under the lowest
//      score a real command earned.
//
//   2. Say nothing to it - hold an ordinary conversation, play a game, talk in
//      Discord. Anything logged here is a false positive, and its confidence is
//      the score the floor has to sit above.
//
// If those two ranges overlap, no floor separates them and the phrase is a bad
// phrase. That is the finding, and it is worth more than any default.
//
// Usage: flash_voice_calibrate.exe [seconds] [extra phrase...]

#include <Windows.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.SpeechRecognition.h>
#include <winrt/Windows.Globalization.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Media::SpeechRecognition;

namespace {

const char* ConfidenceName(SpeechRecognitionConfidence confidence) {
    switch (confidence) {
        case SpeechRecognitionConfidence::High: return "High";
        case SpeechRecognitionConfidence::Medium: return "Medium";
        case SpeechRecognitionConfidence::Low: return "Low";
        case SpeechRecognitionConfidence::Rejected: return "Rejected";
    }
    return "?";
}

struct Hit {
    std::string text;
    double raw = 0.0;
    SpeechRecognitionConfidence confidence = SpeechRecognitionConfidence::Rejected;
    double atSeconds = 0.0;
};

std::mutex hitsMutex;
std::vector<Hit> hits;

std::string Narrow(const hstring& value) {
    const int length = WideCharToMultiByte(CP_UTF8, 0, value.c_str(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return {};
    std::string result(static_cast<size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
        result.data(), length, nullptr, nullptr);
    return result;
}

} // namespace

int main(int argc, char** argv) {
    const double seconds = argc > 1 ? std::atof(argv[1]) : 60.0;

    std::vector<hstring> phrases{
        L"flash clip that", L"flash clip short", L"flash screenshot" };
    for (int i = 2; i < argc; ++i) {
        const int wide = MultiByteToWideChar(CP_UTF8, 0, argv[i], -1, nullptr, 0);
        std::wstring buffer(static_cast<size_t>(wide), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, argv[i], -1, buffer.data(), wide);
        if (!buffer.empty() && buffer.back() == L'\0') buffer.pop_back();
        phrases.emplace_back(buffer);
    }

    init_apartment(apartment_type::multi_threaded);

    try {
        SpeechRecognizer recognizer;
        std::printf("language: %ls\n", recognizer.CurrentLanguage().DisplayName().c_str());
        std::printf("listening for %.0fs. Phrases:\n", seconds);
        for (const auto& phrase : phrases) std::printf("  - %ls\n", phrase.c_str());

        SpeechRecognitionListConstraint constraint(phrases, L"commands");
        recognizer.Constraints().Append(constraint);
        const auto compiled = recognizer.CompileConstraintsAsync().get();
        if (compiled.Status() != SpeechRecognitionResultStatus::Success) {
            std::printf("FAIL constraints did not compile: status=%d\n",
                static_cast<int>(compiled.Status()));
            return 1;
        }

        // Silence must not end the session: the whole point is to sit through
        // long quiet stretches and see what, if anything, wakes it up.
        auto session = recognizer.ContinuousRecognitionSession();
        session.AutoStopSilenceTimeout(std::chrono::hours(24));

        const auto started = std::chrono::steady_clock::now();
        session.ResultGenerated([&started](auto&&, const auto& args) {
            const auto result = args.Result();
            const double at = std::chrono::duration<double>(
                std::chrono::steady_clock::now() - started).count();
            Hit hit{ Narrow(result.Text()), result.RawConfidence(),
                     result.Confidence(), at };
            std::printf("[%6.1fs] raw=%.3f %-8s \"%s\"\n",
                hit.atSeconds, hit.raw, ConfidenceName(hit.confidence), hit.text.c_str());
            std::fflush(stdout);
            std::lock_guard lock(hitsMutex);
            hits.push_back(std::move(hit));
        });

        session.StartAsync().get();
        std::this_thread::sleep_for(std::chrono::duration<double>(seconds));
        try { session.StopAsync().get(); } catch (...) { /* already stopping */ }

        std::lock_guard lock(hitsMutex);
        std::printf("\n%zu match(es) in %.0fs\n", hits.size(), seconds);
        if (hits.empty()) {
            std::printf("nothing matched - either nothing was said, or the phrase is not being heard\n");
            return 0;
        }
        auto lowest = std::min_element(hits.begin(), hits.end(),
            [](const Hit& a, const Hit& b) { return a.raw < b.raw; });
        auto highest = std::max_element(hits.begin(), hits.end(),
            [](const Hit& a, const Hit& b) { return a.raw < b.raw; });
        std::printf("raw confidence range: %.3f (lowest) .. %.3f (highest)\n",
            lowest->raw, highest->raw);
        std::printf("lowest was \"%s\"\n", lowest->text.c_str());
        return 0;
    } catch (const hresult_error& error) {
        std::printf("FAIL 0x%08X %ls\n",
            static_cast<unsigned>(error.code()), error.message().c_str());
        std::printf("if this is an access-denied code, check Settings > Privacy > Microphone\n"
                    "and that desktop apps are allowed to use the microphone.\n");
        return 1;
    }
}
