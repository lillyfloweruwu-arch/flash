#include "../../core/voice_trigger.h"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <future>
#include <mutex>
#include <thread>
#include <utility>

#ifdef _WIN32
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Media.SpeechRecognition.h>
#endif

namespace flash {

struct VoiceTrigger::Impl {
    Impl() {
        std::promise<void> initialized;
        auto ready = initialized.get_future();
        try {
            worker_ = std::thread([this, initialized = std::move(initialized)]() mutable {
                WorkerMain(std::move(initialized));
            });
            ready.get();
        } catch (const std::exception& error) {
            SetUnavailable(std::string("Voice recognition could not start: ") + error.what());
        } catch (...) {
            SetUnavailable("Voice recognition could not start.");
        }
    }

    ~Impl() {
        {
            std::lock_guard lock(queueMutex_);
            stopping_ = true;
        }
        queueChanged_.notify_all();
        if (worker_.joinable()) worker_.join();
    }

    void SetEnabled(bool enabled) noexcept {
        Run([this, enabled] { SetEnabledOnWorker(enabled); });
    }

    bool SetPhrases(const std::vector<std::string>& phrases) noexcept {
        return RunWithResult<bool>(false, [this, phrases] {
            return CompilePhrasesOnWorker(phrases);
        });
    }

    void SetThreshold(double rawFloor, uint32_t cooldownMs) noexcept {
        std::lock_guard lock(gateMutex_);
        gate_.SetThreshold(rawFloor, cooldownMs);
    }

    VoiceStatus GetStatus() const noexcept {
        std::lock_guard lock(stateMutex_);
        return status_;
    }

    void SetCallback(CommandCallback callback) noexcept {
        try {
            std::lock_guard lock(callbackMutex_);
            callback_ = std::move(callback);
        } catch (...) {
            // Losing a callback during process teardown must not escape N-API.
        }
    }

private:
    using Task = std::function<void()>;

    void Run(Task task) noexcept {
        auto completed = std::make_shared<std::promise<void>>();
        auto result = completed->get_future();
        {
            std::lock_guard lock(queueMutex_);
            if (stopping_ || !worker_.joinable()) return;
            tasks_.push_back([task = std::move(task), completed] {
                try { task(); } catch (...) {}
                try { completed->set_value(); } catch (...) {}
            });
        }
        queueChanged_.notify_one();
        try { result.get(); } catch (...) {}
    }

    template <typename T, typename Function>
    T RunWithResult(T fallback, Function function) noexcept {
        auto completed = std::make_shared<std::promise<T>>();
        auto result = completed->get_future();
        {
            std::lock_guard lock(queueMutex_);
            if (stopping_ || !worker_.joinable()) return fallback;
            tasks_.push_back([function = std::move(function), completed, fallback] {
                try { completed->set_value(function()); }
                catch (...) {
                    try { completed->set_value(fallback); } catch (...) {}
                }
            });
        }
        queueChanged_.notify_one();
        try { return result.get(); } catch (...) { return fallback; }
    }

    void WorkerMain(std::promise<void> initialized) noexcept {
#ifdef _WIN32
        bool apartmentInitialized = false;
        try {
            winrt::init_apartment(winrt::apartment_type::multi_threaded);
            apartmentInitialized = true;
            InitializeRecognizer();
        } catch (const winrt::hresult_error& error) {
            SetUnavailable(WinrtError("Voice recognition is unavailable", error));
        } catch (const std::exception& error) {
            SetUnavailable(std::string("Voice recognition is unavailable: ") + error.what());
        } catch (...) {
            SetUnavailable("Voice recognition is unavailable.");
        }
#else
        SetUnavailable("Voice recognition is only available on Windows.");
#endif
        try { initialized.set_value(); } catch (...) {}

        for (;;) {
            Task task;
            bool restart = false;
            {
                std::unique_lock lock(queueMutex_);
                while (!stopping_ && tasks_.empty() && !RestartIsDue()) {
                    if (restartPending_) queueChanged_.wait_until(lock, restartAt_);
                    else queueChanged_.wait(lock);
                }
                if (stopping_) break;
                if (!tasks_.empty()) {
                    task = std::move(tasks_.front());
                    tasks_.pop_front();
                } else if (RestartIsDue()) {
                    restartPending_ = false;
                    restart = true;
                }
            }
            if (task) task();
#ifdef _WIN32
            else if (restart) StartSessionOnWorker();
#endif
        }

#ifdef _WIN32
        ShutdownRecognizer();
        // C++/WinRT caches activation factories as well as the explicit
        // recognizer objects. Release those while COM is still initialized.
        winrt::clear_factory_cache();
        if (apartmentInitialized) winrt::uninit_apartment();
#endif
    }

    bool RestartIsDue() const {
        return restartPending_ && std::chrono::steady_clock::now() >= restartAt_;
    }

    void SetUnavailable(std::string error) {
        std::lock_guard lock(stateMutex_);
        status_.available = false;
        status_.error = std::move(error);
    }

    void SetError(std::string error) {
        std::lock_guard lock(stateMutex_);
        status_.error = std::move(error);
    }

#ifdef _WIN32
    using SpeechRecognizer = winrt::Windows::Media::SpeechRecognition::SpeechRecognizer;
    using SpeechRecognitionListConstraint =
        winrt::Windows::Media::SpeechRecognition::SpeechRecognitionListConstraint;
    using ContinuousSession =
        winrt::Windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession;

    static std::string WinrtError(const char* context, const winrt::hresult_error& error) {
        std::string message = context;
        message += " (0x";
        char code[9]{};
        std::snprintf(code, sizeof(code), "%08X", static_cast<unsigned>(error.code()));
        message += code;
        message += "): ";
        message += winrt::to_string(error.message());
        return message;
    }

    void InitializeRecognizer() {
        using namespace winrt::Windows::Media::SpeechRecognition;

        // This deliberately mirrors the proven unpackaged Win32 probe: use the
        // current Windows speech language and compile a list constraint. The
        // recognizer is constructed before querying languages, in the same
        // order as the probe.
        try {
            recognizer_ = SpeechRecognizer();
        } catch (const winrt::hresult_error&) {
            try {
                if (SpeechRecognizer::SupportedGrammarLanguages().Size() == 0) {
                    SetUnavailable("No Windows speech recognition language pack is installed.");
                    return;
                }
            } catch (...) {}
            throw;
        }
        if (SpeechRecognizer::SupportedGrammarLanguages().Size() == 0) {
            SetUnavailable("No Windows speech recognition language pack is installed.");
            recognizer_ = nullptr;
            return;
        }
        {
            std::lock_guard lock(stateMutex_);
            status_.available = true;
            status_.language = winrt::to_string(recognizer_.CurrentLanguage().LanguageTag());
            status_.error.clear();
        }

        session_ = recognizer_.ContinuousRecognitionSession();
        session_.AutoStopSilenceTimeout(std::chrono::hours(24));
        resultToken_ = session_.ResultGenerated(
            [this](auto&&, const SpeechContinuousRecognitionResultGeneratedEventArgs& args) {
                OnResult(args);
            });
        completedToken_ = session_.Completed(
            [this](auto&&, const SpeechContinuousRecognitionCompletedEventArgs& args) {
                OnCompleted(args);
            });

        const std::vector<std::string> defaults{
            "flash clip that", "flash clip short", "flash screenshot"};
        if (!CompilePhrasesOnWorker(defaults)) {
            // Construction still succeeded, so leave availability true and
            // expose the grammar failure for Settings to explain.
            return;
        }
    }

    bool CompilePhrasesOnWorker(const std::vector<std::string>& phrases) {
        using namespace winrt::Windows::Media::SpeechRecognition;
        if (!recognizer_) return false;
        if (phrases.empty() || std::any_of(phrases.begin(), phrases.end(),
                [](const std::string& phrase) { return phrase.empty(); })) {
            SetError("Voice phrases must contain at least one non-empty phrase.");
            return false;
        }

        StopSessionOnWorker(true);
        try {
            std::vector<winrt::hstring> widePhrases;
            widePhrases.reserve(phrases.size());
            for (const auto& phrase : phrases) widePhrases.push_back(winrt::to_hstring(phrase));

            recognizer_.Constraints().Clear();
            constraint_ = SpeechRecognitionListConstraint(widePhrases, L"commands");
            recognizer_.Constraints().Append(constraint_);
            const auto compiled = recognizer_.CompileConstraintsAsync().get();
            grammarCompiled_ = compiled.Status() == SpeechRecognitionResultStatus::Success;
            if (!grammarCompiled_) {
                SetError("Windows could not compile the voice phrase grammar (status " +
                    std::to_string(static_cast<int>(compiled.Status())) + ").");
                return false;
            }
            SetError("");
            if (enabled_) StartSessionOnWorker();
            return true;
        } catch (const winrt::hresult_error& error) {
            grammarCompiled_ = false;
            SetError(WinrtError("Windows could not compile the voice phrase grammar", error));
            return false;
        } catch (const std::exception& error) {
            grammarCompiled_ = false;
            SetError(std::string("Windows could not compile the voice phrase grammar: ") + error.what());
            return false;
        } catch (...) {
            grammarCompiled_ = false;
            SetError("Windows could not compile the voice phrase grammar.");
            return false;
        }
    }

    void SetEnabledOnWorker(bool enabled) {
        enabled_ = enabled;
        if (!enabled) {
            StopSessionOnWorker(true);
            return;
        }
        if (!recognizer_ || !grammarCompiled_) return;
        StartSessionOnWorker();
    }

    void StartSessionOnWorker() {
        if (!enabled_ || !grammarCompiled_ || !session_ || sessionRunning_) return;
        try {
            sessionRunning_ = true;
            session_.StartAsync().get();
            // A failure completion can race StartAsync's completion. Do not
            // overwrite the event handler's stopped state or its error.
            if (!sessionRunning_) return;
            {
                std::lock_guard lock(queueMutex_);
                sessionStartedAt_ = std::chrono::steady_clock::now();
            }
            SetError("");
        } catch (const winrt::hresult_error& error) {
            sessionRunning_ = false;
            SetError(WinrtError("Voice recognition could not start", error));
            ScheduleRestart();
        } catch (const std::exception& error) {
            sessionRunning_ = false;
            SetError(std::string("Voice recognition could not start: ") + error.what());
            ScheduleRestart();
        } catch (...) {
            sessionRunning_ = false;
            SetError("Voice recognition could not start.");
            ScheduleRestart();
        }
    }

    void StopSessionOnWorker(bool suppressRestart) {
        {
            std::lock_guard lock(queueMutex_);
            restartPending_ = false;
        }
        if (!session_ || !sessionRunning_) return;
        suppressRestart_ = suppressRestart;
        try { session_.StopAsync().get(); } catch (...) {}
        sessionRunning_ = false;
        suppressRestart_ = false;
    }

    void ScheduleRestart() {
        if (!enabled_ || stopping_ || suppressRestart_) return;
        const auto now = std::chrono::steady_clock::now();
        {
            std::lock_guard lock(queueMutex_);
            if (sessionStartedAt_ != std::chrono::steady_clock::time_point{} &&
                now - sessionStartedAt_ >= std::chrono::seconds(30)) {
                restartBackoff_ = std::chrono::seconds(1);
            }
            restartAt_ = now + restartBackoff_;
            restartPending_ = true;
            restartBackoff_ = (std::min)(restartBackoff_ * 2, std::chrono::seconds(30));
        }
        queueChanged_.notify_one();
    }

    void OnResult(
        const winrt::Windows::Media::SpeechRecognition::
            SpeechContinuousRecognitionResultGeneratedEventArgs& args) noexcept {
        try {
            const auto result = args.Result();

            // Rejected is the recogniser saying it heard speech that is not in
            // the grammar, and it is the single most valuable signal here: in
            // calibration, a sentence that matched no phrase came back
            // Rejected rather than being forced onto a nearest command. Those
            // results carry a raw confidence of zero today, so the floor alone
            // would catch them - but that is a coincidence of the API, not a
            // promise, and an empty phrase must never reach the callback and
            // be looked up as a command.
            if (result.Confidence() == winrt::Windows::Media::SpeechRecognition::
                    SpeechRecognitionConfidence::Rejected) return;
            if (result.Text().empty()) return;

            const double rawConfidence = result.RawConfidence();
            {
                std::lock_guard lock(gateMutex_);
                if (!gate_.Accept(rawConfidence, VoiceTriggerGate::Clock::now())) return;
            }

            CommandCallback callback;
            {
                std::lock_guard lock(callbackMutex_);
                callback = callback_;
            }
            if (callback) callback(winrt::to_string(result.Text()), rawConfidence);
        } catch (...) {
            // Recognition events arrive on a WinRT thread. No failure here may
            // escape into WinRT or cross the native-addon boundary.
        }
    }

    void OnCompleted(
        const winrt::Windows::Media::SpeechRecognition::
            SpeechContinuousRecognitionCompletedEventArgs& args) noexcept {
        try {
            sessionRunning_ = false;
            if (!enabled_ || stopping_ || suppressRestart_) return;
            SetError("Voice recognition stopped unexpectedly (status " +
                std::to_string(static_cast<int>(args.Status())) + "); restarting.");
            ScheduleRestart();
        } catch (...) {}
    }

    void ShutdownRecognizer() noexcept {
        enabled_ = false;
        StopSessionOnWorker(true);
        try {
            if (session_ && resultToken_.value) session_.ResultGenerated(resultToken_);
            if (session_ && completedToken_.value) session_.Completed(completedToken_);
        } catch (...) {}
        constraint_ = nullptr;
        session_ = nullptr;
        recognizer_ = nullptr;
    }

    SpeechRecognizer recognizer_{nullptr};
    SpeechRecognitionListConstraint constraint_{nullptr};
    ContinuousSession session_{nullptr};
    winrt::event_token resultToken_{};
    winrt::event_token completedToken_{};
    bool grammarCompiled_ = false;
    std::atomic<bool> enabled_{false};
    std::atomic<bool> sessionRunning_{false};
    std::atomic<bool> suppressRestart_{false};
    std::chrono::steady_clock::time_point sessionStartedAt_{};
    std::chrono::seconds restartBackoff_{1};
#else
    void SetEnabledOnWorker(bool) {}
#endif

    mutable std::mutex stateMutex_;
    VoiceStatus status_;

    std::mutex gateMutex_;
    VoiceTriggerGate gate_;
    std::mutex callbackMutex_;
    CommandCallback callback_;

    std::thread worker_;
    mutable std::mutex queueMutex_;
    std::condition_variable queueChanged_;
    std::deque<Task> tasks_;
    std::atomic<bool> stopping_{false};
    bool restartPending_ = false;
    std::chrono::steady_clock::time_point restartAt_{};
};

VoiceTrigger::VoiceTrigger() : impl_(std::make_unique<Impl>()) {}
VoiceTrigger::~VoiceTrigger() = default;

void VoiceTrigger::SetEnabled(bool enabled) noexcept {
    if (impl_) impl_->SetEnabled(enabled);
}

bool VoiceTrigger::SetPhrases(const std::vector<std::string>& phrases) noexcept {
    return impl_ && impl_->SetPhrases(phrases);
}

void VoiceTrigger::SetThreshold(double rawFloor, uint32_t cooldownMs) noexcept {
    if (impl_) impl_->SetThreshold(rawFloor, cooldownMs);
}

VoiceStatus VoiceTrigger::GetStatus() const noexcept {
    return impl_ ? impl_->GetStatus()
                 : VoiceStatus{false, "", "Voice recognition is unavailable."};
}

void VoiceTrigger::SetCallback(CommandCallback callback) noexcept {
    if (impl_) impl_->SetCallback(std::move(callback));
}

} // namespace flash
