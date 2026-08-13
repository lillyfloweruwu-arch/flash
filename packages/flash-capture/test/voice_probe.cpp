// Feasibility probe for voice activation. Answers, on this machine and from a
// plain unpackaged Win32 process, the questions the design depends on:
//
//   1. Can SpeechRecognizer even be constructed outside an MSIX package?
//   2. Does a list constraint compile? A list constraint is the offline path;
//      dictation needs the online-speech privacy setting and we do not want it.
//   3. Which language does it recognise, and is a speech language pack present?
//
// This is a probe, not a self-check: it reports rather than asserts, because
// "no language pack installed" is a real answer about the machine and not a
// defect in the code.

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.SpeechRecognition.h>
#include <winrt/Windows.Globalization.h>

#include <cstdio>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Media::SpeechRecognition;

int main() {
    try {
        init_apartment(apartment_type::multi_threaded);
    } catch (const hresult_error& error) {
        std::printf("FAIL init_apartment: 0x%08X %ls\n",
            static_cast<unsigned>(error.code()), error.message().c_str());
        return 1;
    }

    try {
        SpeechRecognizer recognizer;
        std::printf("OK   SpeechRecognizer constructed\n");
        std::printf("     current language: %ls\n",
            recognizer.CurrentLanguage().DisplayName().c_str());

        const auto supported = SpeechRecognizer::SupportedGrammarLanguages();
        std::printf("     grammar languages installed: %u\n", supported.Size());
        for (const auto& language : supported)
            std::printf("       - %ls\n", language.DisplayName().c_str());

        std::vector<hstring> phrases{
            L"flash clip that", L"flash clip short", L"flash screenshot" };
        SpeechRecognitionListConstraint constraint(phrases, L"commands");
        recognizer.Constraints().Append(constraint);

        const auto result = recognizer.CompileConstraintsAsync().get();
        const auto status = result.Status();
        std::printf("%s CompileConstraintsAsync status=%d\n",
            status == SpeechRecognitionResultStatus::Success ? "OK  " : "FAIL",
            static_cast<int>(status));
        if (status != SpeechRecognitionResultStatus::Success) return 1;

        std::printf("OK   list constraint compiled offline\n");
        return 0;
    } catch (const hresult_error& error) {
        std::printf("FAIL 0x%08X %ls\n",
            static_cast<unsigned>(error.code()), error.message().c_str());
        return 1;
    }
}
