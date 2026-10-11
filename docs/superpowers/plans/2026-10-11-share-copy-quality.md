# Share Copy Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Export to size" produces an AV1 (or HEVC, or H.264 High) copy at 60 fps that lands between 88% and 100% of the chosen limit, on Windows and Linux.

**Architecture:** All sizing decisions (codec-aware resolution, frame-rate ladder, even frame grid, symmetric retry) live in the portable header `export_budget.h` and are unit-tested there. Each platform exporter (Media Foundation on Windows, libav on Linux) walks a codec ladder, encodes up to three times, and publishes the largest attempt that fits. The desktop app passes a codec choice and a 60 fps cap for share copies; editor saves stay H.264 with no cap.

**Tech Stack:** C++17, Media Foundation sink writer (Windows), libavcodec/libavformat 7.1 LGPL build (Linux), N-API addon built with cmake-js, Electron + React + TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-10-flash-share-copy-quality-design.md`

## Global Constraints

- No ffmpeg binary or new library is bundled on Windows. No x264, x265 or any GPL/nonfree code on Linux.
- AV1 and HEVC are used only through a hardware encoder. H.264 is always requested as High profile.
- Windows `Auto` ladder: AV1, HEVC, H.264. Linux `Auto` ladder: AV1, H.264 (HEVC skipped).
- Share copies pass `maxFps: 60`. A source below the cap is never raised.
- Bits-per-pixel floors: 0.05 H.264, 0.033 HEVC, 0.03 AV1.
- Size window: first attempt aims at 94% of the limit; under 88% retries higher unless video bitrate already equals the source bitrate; over 100% retries lower; at most three encodes; the limit is a hard ceiling.
- Editor saves (`maxBytes: Number.MAX_SAFE_INTEGER`) pass `codec: 'h264'`, no `maxFps`, and are never retried for size.
- Compatible copy filename: `<name> - 10MB H264.mp4`.
- Linux code cannot be compiled or run on the development machine. Linux tasks are written for the Ubuntu CI job to compile; nothing in this plan claims a Linux export was run.
- The addon's native default for `codec` is H.264 and for `maxFps` is 0, so every existing caller behaves as before unless it opts in.
- Work on branch `share-copy-quality`. Do not push. `apps/desktop/.impeccable/hook.cache.json` is a pre-existing local change; never stage it.

## Review Focus

1. A very short clip (2 to 4 s) at 10MB: the bitrate hits the source bitrate. Expect a small file published after one encode, not three encodes chasing 88%. Pinned in Task 1 (`ExportNeedsRetry` at the cap).
2. A capture hitch: source timestamps that repeat or jump forward. Expect output frames that never repeat a slot or go backward. Pinned in Task 1 (`FrameGrid` gap and duplicate cases).
3. A PC with no AV1 or HEVC hardware encoder choosing "10MB". Expect an H.264 High copy and a note naming the codec, not a failure. Pinned in Task 3 (`FLASH_EXPORT_CODEC=h264` probe run) and Task 4 (`codecNote` test).
4. A retry upward that overshoots the limit. Expect the earlier attempt that fit to be the published file, and the result's `bytes` to match the file on disk. Pinned in Task 3 (probe asserts `bytes` equals the published file's size and is within the limit at three budgets).
5. An editor save of a 141 fps clip. Expect the original frame rate and timestamps, H.264, one encode. Pinned in Task 1 (`maxFps` 0 and unlimited-budget cases) and Task 3 (existing `every-native-path.js` editor-save check still passes).

---

### Task 1: Portable sizing logic

**Files:**
- Modify: `packages/flash-capture/src/core/export_budget.h` (whole file replaced)
- Test: `packages/flash-capture/test/export_budget_test.cpp`

**Interfaces:**
- Consumes: nothing.
- Produces (all in namespace `flash`, header-only):
  - `enum class ExportCodec { H264, Hevc, Av1 };`
  - `const char* ExportCodecName(ExportCodec)` returning `"h264"`, `"hevc"`, `"av1"`
  - `bool ParseExportCodec(const char* text, ExportCodec& out)` (accepts those three names, null-safe)
  - `double MinBitsPerPixel(ExportCodec)`
  - `struct ExportPlan { uint32_t width, height, videoKbps, audioKbps, fps; ExportCodec codec; uint32_t maxVideoKbps; }`
  - `constexpr double kExportFill = 0.94, kExportFloor = 0.88;`
  - `constexpr uint64_t kExportUnlimitedBytes = 1ull << 40;`
  - `ExportPlan PlanExport(uint32_t sourceWidth, uint32_t sourceHeight, uint32_t fps, double durationSeconds, uint64_t maxBytes, uint32_t maxHeight, ExportCodec codec = ExportCodec::H264, uint32_t maxFps = 0, uint32_t sourceKbps = 0)`
  - `bool ExportNeedsRetry(const ExportPlan& plan, uint64_t budget, uint64_t actual)`
  - `ExportPlan RetryExportPlan(const ExportPlan& previous, uint64_t budget, uint64_t actual)`
  - `struct FrameGrid { uint32_t fps; int64_t next = 0; int64_t Take(int64_t timeUs); }` where `Take` returns the output slot index for a frame at `timeUs` microseconds from the export start, or -1 to drop it.

- [ ] **Step 1: Create the branch and commit the spec and plan**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
git checkout -b share-copy-quality
git add docs/superpowers/specs/2026-10-10-flash-share-copy-quality-design.md docs/superpowers/plans/2026-10-11-share-copy-quality.md
git commit -m "docs: share copy quality spec and plan"
```

- [ ] **Step 2: Write the failing tests**

In `packages/flash-capture/test/export_budget_test.cpp`:

Replace the line `const double budgetKbits = (10.0 * 1024 * 1024 * 8 * 0.95) / 1000.0 / 30.0;` with:

```cpp
        const double budgetKbits = (10.0 * 1024 * 1024 * 8 * kExportFill) / 1000.0 / 30.0;
```

Replace the line `const auto floorBytes = static_cast<uint64_t>(std::ceil(428000.0 * 10 / 8 / 0.95));` with:

```cpp
        const auto floorBytes = static_cast<uint64_t>(std::ceil(428000.0 * 10 / 8 / kExportFill));
```

Replace the whole block that starts `const ExportPlan previous{1920, 1080, 2000, 128, 60};` (through its closing brace) with:

```cpp
    {
        const ExportPlan previous{1920, 1080, 2000, 128, 60};
        // Over the limit: scale toward 94% of it.
        const auto retry = RetryExportPlan(previous, 1000, 2000);
        assert(retry.videoKbps == 940 && retry.height == 1080);
        const auto starved = RetryExportPlan(previous, 100, 2000);
        assert(starved.videoKbps == kExportMinVideoKbps);
        assert(starved.height == 720 && starved.width == 1280);
        assert(starved.audioKbps == previous.audioKbps && starved.fps == previous.fps);
        assert(RetryExportPlan(previous, 100, 0).width == 0);
        const ExportPlan smallest{640, 360, 300, 128, 30};
        assert(RetryExportPlan(smallest, 100, 200).height == 360);
        // Under the limit: scale up toward 94%, never past the source bitrate.
        assert(RetryExportPlan(previous, 10000, 7000).videoKbps == 2685);
        ExportPlan capped = previous;
        capped.maxVideoKbps = 2500;
        assert(RetryExportPlan(capped, 10000, 7000).videoKbps == 2500);
        assert(RetryExportPlan(capped, 10000, 7000).codec == previous.codec);
    }

    // When to encode again.
    {
        ExportPlan plan{1920, 1080, 2000, 128, 60};
        assert(ExportNeedsRetry(plan, 1000, 1001));            // over the limit
        assert(!ExportNeedsRetry(plan, 1000, 1000));           // exactly at it
        assert(!ExportNeedsRetry(plan, 1000, 880));            // inside the window
        assert(ExportNeedsRetry(plan, 1000, 879));             // wasted quality
        // A short clip already at the source bitrate is allowed to be small.
        plan.maxVideoKbps = 2000;
        assert(!ExportNeedsRetry(plan, 1000, 100));
        // The editor's unlimited budget never chases a size.
        ExportPlan editor{1920, 1080, 20000, 128, 141};
        assert(!ExportNeedsRetry(editor, 9007199254740991ull, 5000000));
    }

    // Codec decides how much resolution a bitrate can carry. The reference clip:
    // 1080p at about 141 fps, 14.3 s, Discord's 10 MiB.
    {
        const uint64_t limit = 10ull * 1024 * 1024;
        const auto av1 = PlanExport(1920, 1080, 141, 14.3, limit, 0, ExportCodec::Av1, 60, 27000);
        assert(av1.height == 1080 && av1.fps == 60 && av1.codec == ExportCodec::Av1);
        const auto hevc = PlanExport(1920, 1080, 141, 14.3, limit, 0, ExportCodec::Hevc, 60, 27000);
        assert(hevc.height == 1080 && hevc.fps == 60);
        const auto h264 = PlanExport(1920, 1080, 141, 14.3, limit, 0, ExportCodec::H264, 60, 27000);
        assert(h264.height == 720 && h264.width == 1280 && h264.fps == 60);
    }

    // The cap only lowers a frame rate. No cap leaves it alone.
    {
        assert(PlanExport(1920, 1080, 141, 14.3, 500ull * 1024 * 1024, 0, ExportCodec::H264, 0, 0).fps == 141);
        assert(PlanExport(1920, 1080, 30, 14.3, 500ull * 1024 * 1024, 0, ExportCodec::H264, 60, 0).fps == 30);
        assert(PlanExport(1920, 1080, 24, 14.3, 500ull * 1024 * 1024, 0, ExportCodec::H264, 60, 0).fps == 24);
    }

    // A copy never gets more bits than the clip it came from.
    {
        const auto plan = PlanExport(1920, 1080, 60, 4.0, 10ull * 1024 * 1024, 0, ExportCodec::H264, 60, 8000);
        assert(plan.videoKbps == 8000 && plan.maxVideoKbps == 8000);
    }

    // Codec names round-trip, and junk is refused.
    {
        ExportCodec codec = ExportCodec::H264;
        assert(ParseExportCodec("av1", codec) && codec == ExportCodec::Av1);
        assert(ParseExportCodec("hevc", codec) && codec == ExportCodec::Hevc);
        assert(ParseExportCodec("h264", codec) && codec == ExportCodec::H264);
        assert(!ParseExportCodec("vp9", codec) && !ParseExportCodec(nullptr, codec));
        assert(std::string(ExportCodecName(ExportCodec::Av1)) == "av1");
    }

    // The frame grid: a 141 fps source becomes an even 60 fps with no slot
    // repeated and none out of order.
    {
        FrameGrid grid{60};
        int64_t last = -1;
        int taken = 0;
        for (int i = 0; i < 141; ++i) {
            const int64_t slot = grid.Take(static_cast<int64_t>(i) * 1000000 / 141);
            if (slot < 0) continue;
            assert(slot > last);
            last = slot;
            ++taken;
        }
        assert(taken >= 59 && taken <= 61);
    }
    // A source already at the grid rate keeps every frame, despite its
    // timestamps being truncated to whole microseconds.
    {
        FrameGrid grid{60};
        for (int i = 0; i < 120; ++i) assert(grid.Take(static_cast<int64_t>(i) * 1000000 / 60) == i);
    }
    // A hitch: a repeated timestamp is dropped, and a jump skips slots instead
    // of bunching frames up behind it.
    {
        FrameGrid grid{60};
        assert(grid.Take(0) == 0);
        assert(grid.Take(0) == -1);
        assert(grid.Take(100000) == 6);
        assert(grid.Take(90000) == -1);
        assert(grid.Take(-5) == -1);
    }
```

Add `#include <string>` under the existing includes at the top of the test file.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/packages/flash-capture"
cmake --build build --config Release --target flash_export_budget_test
```

Expected: the build FAILS with errors such as `'kExportFill': undeclared identifier` and `'ExportCodec': is not a class or namespace name`. If `build/` does not exist, run `pnpm --filter @flash/capture run build` from the repo root first, then repeat.

- [ ] **Step 4: Replace `export_budget.h`**

Write `packages/flash-capture/src/core/export_budget.h` as:

```cpp
#pragma once

#include <algorithm>
#include <cstdint>
#include <cmath>
#include <cstring>

namespace flash {

// Pure arithmetic for sizing a share copy, kept free of Media Foundation and
// libav so it can be unit-tested on its own and shared by both platforms.

enum class ExportCodec { H264, Hevc, Av1 };

inline const char* ExportCodecName(ExportCodec codec) {
    switch (codec) {
        case ExportCodec::Av1: return "av1";
        case ExportCodec::Hevc: return "hevc";
        default: return "h264";
    }
}

inline bool ParseExportCodec(const char* text, ExportCodec& out) {
    if (!text) return false;
    for (ExportCodec codec : {ExportCodec::H264, ExportCodec::Hevc, ExportCodec::Av1})
        if (std::strcmp(text, ExportCodecName(codec)) == 0) { out = codec; return true; }
    return false;
}

// Bits a frame can afford at a given resolution before it stops being watchable.
// Below roughly 0.05 bits per pixel per frame H.264 turns to mush; the newer
// codecs hold up at about two thirds of that, which is the whole reason a 10MB
// copy can stay at 1080p under them.
inline double MinBitsPerPixel(ExportCodec codec) {
    switch (codec) {
        case ExportCodec::Av1: return 0.03;
        case ExportCodec::Hevc: return 0.033;
        default: return 0.05;
    }
}

struct ExportPlan {
    uint32_t width = 0, height = 0;
    uint32_t videoKbps = 0, audioKbps = 0;
    uint32_t fps = 0;
    ExportCodec codec = ExportCodec::H264;
    // The source's own bitrate when a real size limit applies; 0 means no cap
    // beyond kExportMaxVideoKbps. A copy never needs more bits than its source.
    uint32_t maxVideoKbps = 0;
};

constexpr uint32_t kExportAudioKbps = 128;
constexpr uint32_t kExportMinVideoKbps = 300;

// The editor's full-quality save asks for a budget of Number.MAX_SAFE_INTEGER,
// meaning "do not downscale for size". Unclamped, that came out as a bitrate of
// around 1.7e13 kbps, which does not fit the uint32 it is stored in, and the
// encoder answered MF_E_INVALIDMEDIATYPE — so every re-encoding save from the
// editor failed. This is the same ceiling setQuality already enforces on the
// recording path, and it is far above any real 4K bitrate.
constexpr uint32_t kExportMaxVideoKbps = 200000;

// A share copy aims at 94% of its limit and is encoded again if it lands under
// 88%: the limit is a hard ceiling, but a copy far below it threw quality away.
constexpr double kExportFill = 0.94;
constexpr double kExportFloor = 0.88;
// Budgets at or above this are "no size limit" (the editor's save), and are
// never encoded twice to chase a size.
constexpr uint64_t kExportUnlimitedBytes = 1ull << 40;

inline double BitsPerPixelPerFrame(uint32_t width, uint32_t height, uint32_t fps, uint32_t kbps) {
    const double pixels = static_cast<double>(width) * height * (fps ? fps : 1);
    return pixels > 0.0 ? (kbps * 1000.0) / pixels : 0.0;
}

// Chooses the largest standard height that both fits under the caller's ceiling
// and still earns its bitrate. Width follows the source aspect, rounded even
// because every codec here requires it.
inline ExportPlan PlanExport(uint32_t sourceWidth, uint32_t sourceHeight, uint32_t fps,
                             double durationSeconds, uint64_t maxBytes, uint32_t maxHeight,
                             ExportCodec codec = ExportCodec::H264, uint32_t maxFps = 0,
                             uint32_t sourceKbps = 0) {
    ExportPlan plan;
    plan.audioKbps = kExportAudioKbps;
    plan.codec = codec;
    if (!sourceWidth || !sourceHeight || !std::isfinite(durationSeconds) || durationSeconds <= 0.0 || !maxBytes) return plan;

    const double totalKbits = (static_cast<double>(maxBytes) * 8.0 * kExportFill) / 1000.0;
    // Even a sub-frame range needs one frame. Refuse budgets below the minimum
    // video/audio rates instead of encoding a file that cannot possibly fit.
    const double shortestOutput = (std::max)(durationSeconds, 1.0 / (fps ? fps : 30));
    double videoKbps = totalKbits / shortestOutput - plan.audioKbps;
    if (videoKbps < kExportMinVideoKbps) return plan;
    if (videoKbps > kExportMaxVideoKbps) videoKbps = kExportMaxVideoKbps;
    if (sourceKbps >= kExportMinVideoKbps) {
        plan.maxVideoKbps = (std::min)(sourceKbps, kExportMaxVideoKbps);
        if (videoKbps > plan.maxVideoKbps) videoKbps = plan.maxVideoKbps;
    }

    const uint32_t ceiling = maxHeight ? (std::min)(maxHeight, sourceHeight) : sourceHeight;
    const uint32_t ladder[] = {2160, 1440, 1080, 720, 480, 360};
    const double floor = MinBitsPerPixel(codec);
    uint32_t height = 0;

    // The source rate, lowered to the caller's cap, then 30. A share copy at
    // 720p30 beats 480p60: halving the frame rate doubles the bits each frame
    // can have, and legible HUD text matters more than smoothness in a clip
    // someone watches once in a chat window. A rate is never raised.
    const uint32_t sourceFps = fps ? fps : 30;
    const uint32_t first = maxFps ? (std::min)(sourceFps, maxFps) : sourceFps;
    const uint32_t rates[] = {first, (std::min)(first, 30u)};
    plan.fps = first;
    for (uint32_t rate : rates) {
        height = 0;
        for (uint32_t candidate : ladder) {
            if (candidate > ceiling) continue;
            const uint32_t width = static_cast<uint32_t>(
                (static_cast<uint64_t>(sourceWidth) * candidate + sourceHeight / 2) / sourceHeight) & ~1u;
            if (BitsPerPixelPerFrame(width, candidate, rate, static_cast<uint32_t>(videoKbps)) >= floor) {
                height = candidate;
                plan.width = width ? width : 2;
                plan.fps = rate;
                break;
            }
        }
        // Accept the first rate that keeps at least 720p; otherwise try the lower one.
        if (height >= 720 || rate == rates[1]) break;
    }
    if (!height) {   // even the smallest rung is starved; take it anyway
        height = (std::min)(ceiling, 360u);
        plan.width = static_cast<uint32_t>(
            (static_cast<uint64_t>(sourceWidth) * height + sourceHeight / 2) / sourceHeight) & ~1u;
        if (!plan.width) plan.width = 2;
    }
    plan.height = height & ~1u;
    if (!plan.height) plan.height = 2;
    plan.videoKbps = static_cast<uint32_t>(videoKbps);
    return plan;
}

// Whether an encode at `plan` that came out at `actual` bytes should be tried
// again: always when it is over the limit, and when it is well under one that
// still has bitrate left to give.
inline bool ExportNeedsRetry(const ExportPlan& plan, uint64_t budget, uint64_t actual) {
    if (actual > budget) return true;
    if (budget >= kExportUnlimitedBytes) return false;
    const uint32_t ceiling = plan.maxVideoKbps ? plan.maxVideoKbps : kExportMaxVideoKbps;
    return static_cast<double>(actual) < static_cast<double>(budget) * kExportFloor && plan.videoKbps < ceiling;
}

// Scales the video bitrate so the next attempt lands on 94% of the budget, in
// either direction. Scaling video alone moves the whole file by slightly less
// than the ratio, because audio stays put — which errs toward the safe side
// both ways. Drops a resolution rung only when the bitrate would starve.
inline ExportPlan RetryExportPlan(const ExportPlan& previous, uint64_t budget, uint64_t actual) {
    ExportPlan plan = previous;
    if (!actual || !budget) return {};
    const double bitrate = previous.videoKbps * (static_cast<double>(budget) * kExportFill / actual);
    if (bitrate < kExportMinVideoKbps) {
        for (uint32_t height : {2160u, 1440u, 1080u, 720u, 480u, 360u}) {
            if (height >= previous.height) continue;
            plan.height = height;
            plan.width = (std::max)(2u, static_cast<uint32_t>(
                static_cast<uint64_t>(previous.width) * height / previous.height) & ~1u);
            break;
        }
    }
    const double ceiling = previous.maxVideoKbps ? previous.maxVideoKbps : kExportMaxVideoKbps;
    plan.videoKbps = static_cast<uint32_t>((std::max)(static_cast<double>(kExportMinVideoKbps),
        (std::min)(bitrate, ceiling)));
    return plan;
}

// Picks frames for a constant-rate output from a source that may be faster and
// irregular. Each source frame belongs to the slot nearest its timestamp; the
// first frame to reach a slot takes it and later ones are dropped. Nearest, not
// floor, because timestamps are truncated: a 60 fps source's second frame sits
// at 16666 us, a hair short of slot 1.
struct FrameGrid {
    uint32_t fps = 60;
    int64_t next = 0;
    // Returns the output slot for a frame `timeUs` after the export start, or
    // -1 to drop it. The caller stamps the frame at slot / fps.
    int64_t Take(int64_t timeUs) {
        if (timeUs < 0 || !fps) return -1;
        const int64_t slot = (timeUs * fps + 500000) / 1000000;
        if (slot < next) return -1;
        next = slot + 1;
        return slot;
    }
};

} // namespace flash
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/packages/flash-capture"
cmake --build build --config Release --target flash_export_budget_test && ./build/Release/flash_export_budget_test.exe
```

Expected: `export budget self-check passed`. The addon itself must also still build, because both exporters include this header with the old call shape (the new parameters are defaulted):

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash" && pnpm --filter @flash/capture run build
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/flash-capture/src/core/export_budget.h packages/flash-capture/test/export_budget_test.cpp
git commit -m "feat(export): codec-aware plan, frame grid and symmetric size retry"
```

---

### Task 2: Options, result and binding

**Files:**
- Modify: `packages/flash-capture/src/core/clip_exporter.h`
- Modify: `packages/flash-capture/src/binding.cpp` (`ExportClipWorker::OnOK`, `ExportClipBinding`)
- Modify: `scripts/probes/export-and-game.js` (safe section)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `enum class ExportCodecChoice { H264, Auto };`
  - `ExportOptions::codec` (`ExportCodecChoice`, default `H264`), `ExportOptions::maxFps` (`uint32_t`, default 0)
  - `ExportResult::codec` (`std::string`, default `"h264"`)
  - JS: `exportClip(input, output, { ..., codec?: 'auto' | 'h264', maxFps?: number })` resolving with an added `codec: 'av1' | 'hevc' | 'h264'`. Any other `codec` string throws a `TypeError` synchronously.

- [ ] **Step 1: Write the failing check**

In `scripts/probes/export-and-game.js`, inside the `if (safe) {` block, immediately after the line `fs.writeFileSync(existing, 'keep original output')`, add:

```js
      // Option validation happens before any media is touched.
      assert.throws(() => addon.exportClip(input, path.join(dir, 'x.mp4'), { maxBytes: 1000000, codec: 'vp9' }), /codec must be/)
      assert.throws(() => addon.exportClip(input, path.join(dir, 'x.mp4'), { maxBytes: 1000000, maxFps: -1 }), /maxFps must be/)
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
node --experimental-strip-types scripts/probes/export-and-game.js --safe
```

Expected: FAIL with `AssertionError [ERR_ASSERTION]: Missing expected exception.`

- [ ] **Step 3: Add the fields**

In `packages/flash-capture/src/core/clip_exporter.h`, add above `struct ExportOptions`:

```cpp
// What the caller asked for. Auto walks the platform's codec ladder and takes
// the first one with a hardware encoder; the result says which it got.
enum class ExportCodecChoice { H264, Auto };
```

Inside `ExportOptions`, after the `saturation` line, add:

```cpp
    ExportCodecChoice codec = ExportCodecChoice::H264;
    uint32_t maxFps = 0;         // 0 = keep the source frame rate
```

Inside `ExportResult`, after the `bitrateKbps` line, add:

```cpp
    std::string codec = "h264";  // "av1", "hevc" or "h264": what was actually encoded
```

- [ ] **Step 4: Parse and return them in the binding**

In `packages/flash-capture/src/binding.cpp`, in `ExportClipWorker::OnOK`, after `value.Set("bitrateKbps", result_.bitrateKbps);` add:

```cpp
        value.Set("codec", result_.codec);
```

In `ExportClipBinding`, immediately before the line `auto* worker = new ExportClipWorker(` add:

```cpp
    if (!options.Get("codec").IsUndefined()) {
        const std::string codec = options.Get("codec").IsString() ? options.Get("codec").As<Napi::String>().Utf8Value() : "";
        if (codec == "auto") parsed.codec = ExportCodecChoice::Auto;
        else if (codec == "h264") parsed.codec = ExportCodecChoice::H264;
        else {
            Napi::TypeError::New(env, "codec must be 'auto' or 'h264'").ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }
    if (!options.Get("maxFps").IsUndefined()) {
        const double maxFps = options.Get("maxFps").IsNumber() ? options.Get("maxFps").As<Napi::Number>().DoubleValue() : -1.0;
        if (!std::isfinite(maxFps) || maxFps < 0.0 || maxFps > 1000.0) {
            Napi::RangeError::New(env, "maxFps must be a number between 0 and 1000").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        parsed.maxFps = static_cast<uint32_t>(maxFps);
    }
```

Change the usage string in the same function from `{ maxBytes, maxHeight?, startSeconds?, endSeconds? }` to `{ maxBytes, maxHeight?, startSeconds?, endSeconds?, codec?, maxFps? }`.

- [ ] **Step 5: Build and run the check**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm --filter @flash/capture run build && node --experimental-strip-types scripts/probes/export-and-game.js --safe
```

Expected: every line printed starts with `PASS`, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/flash-capture/src/core/clip_exporter.h packages/flash-capture/src/binding.cpp scripts/probes/export-and-game.js
git commit -m "feat(export): codec and maxFps options, codec in the result"
```

---

### Task 3: Windows exporter

**Files:**
- Modify: `packages/flash-capture/src/platform/windows/clip_exporter.cpp`
- Create: `scripts/probes/share-copy.js`

**Interfaces:**
- Consumes: everything Task 1 produces; `ExportCodecChoice`, `ExportOptions::codec`, `ExportOptions::maxFps`, `ExportResult::codec` from Task 2.
- Produces: `ExportClip` honours `codec` and `maxFps`. Environment variable `FLASH_EXPORT_CODEC` (`av1`, `hevc` or `h264`) forces where the `Auto` ladder starts; it is for testing and has no effect on `codec: 'h264'`.

- [ ] **Step 1: Write the failing probe**

Create `scripts/probes/share-copy.js`:

```js
// Exports a real clip as a share copy and checks codec, frame rate and size.
// Needs a GPU and a saved clip, so it is not part of `pnpm test`.
//   node scripts/probes/share-copy.js "<clip.mp4>" [av1|hevc|h264]
// The second argument is the codec `Auto` is expected to choose on this machine
// (default av1). Set FLASH_EXPORT_CODEC to force a lower step of the ladder.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os')
const assert = require('node:assert/strict')
const addon = require(path.join(__dirname, '../../packages/flash-capture/build',
  process.platform === 'win32' ? 'Release' : '', 'flash_capture.node'))

const clip = process.argv[2]
const expected = process.argv[3] ?? 'av1'
if (!clip || !fs.existsSync(clip)) { console.error('usage: share-copy.js <clip.mp4> [av1|hevc|h264]'); process.exit(2) }

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-share-copy-'))
  try {
    for (const mb of [10, 25, 4]) {
      const maxBytes = mb * 1024 * 1024
      const out = path.join(dir, `auto-${mb}.mp4`)
      const r = await addon.exportClip(clip, out, { maxBytes, codec: 'auto', maxFps: 60 })
      const onDisk = fs.statSync(out).size
      console.log(`auto ${mb}MB: ${r.codec} ${r.width}x${r.height} ${(onDisk / 1048576).toFixed(2)} MiB (${Math.round(onDisk / maxBytes * 100)}% of limit)`)
      assert.equal(r.codec, expected, `Auto chose ${r.codec}, expected ${expected}`)
      assert.equal(r.bytes, onDisk, 'reported bytes must be the published file')
      assert.ok(onDisk <= maxBytes, 'the limit is a hard ceiling')
      assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.partial')), [], 'no partial files left behind')
    }
    const compatible = path.join(dir, 'h264.mp4')
    const h = await addon.exportClip(clip, compatible, { maxBytes: 10 * 1024 * 1024, codec: 'h264', maxFps: 60 })
    console.log(`h264 10MB: ${h.codec} ${h.width}x${h.height} ${(h.bytes / 1048576).toFixed(2)} MiB`)
    assert.equal(h.codec, 'h264')
    assert.ok(h.bytes <= 10 * 1024 * 1024)
    console.log(`PASS. Outputs kept in ${dir} for ffprobe; delete when done.`)
  } catch (error) {
    console.error(`FAIL: ${error.message}\nOutputs in ${dir}`)
    process.exit(1)
  }
})()
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
node scripts/probes/share-copy.js "C:/Users/emers/Videos/Flash/Rocket League/2026-10-09_22-15-41.mp4"
```

Expected: `FAIL: Auto chose h264, expected av1`.

- [ ] **Step 3: Add the includes and the ladder helpers**

In `packages/flash-capture/src/platform/windows/clip_exporter.cpp`, add to the Windows include block (after `#include <mfreadwrite.h>`):

```cpp
#include <mftransform.h>
#include <codecapi.h>
```

and add `#include <cstdlib>` to the standard includes at the top.

Inside the anonymous namespace, after `MakeType`, add:

```cpp
// Thrown when the chosen codec cannot be set up, so the caller can step down
// the ladder. Anything that fails once writing has begun is a real error.
struct CodecUnavailable final : std::runtime_error {
    using std::runtime_error::runtime_error;
};

const GUID& Subtype(ExportCodec codec) {
    switch (codec) {
        case ExportCodec::Av1: return MFVideoFormat_AV1;
        case ExportCodec::Hevc: return MFVideoFormat_HEVC;
        default: return MFVideoFormat_H264;
    }
}

// AV1 and HEVC are only worth using through the GPU: Windows ships no software
// encoder for either.
bool HasHardwareEncoder(const GUID& subtype) {
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, subtype};
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    const HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr, &output, &activates, &count);
    if (FAILED(hr)) return false;
    for (UINT32 i = 0; i < count; ++i) activates[i]->Release();
    CoTaskMemFree(activates);
    return count > 0;
}

std::vector<ExportCodec> CodecLadder(ExportCodecChoice choice) {
    if (choice == ExportCodecChoice::H264) return {ExportCodec::H264};
    // A test hook: start the ladder at a given step, so the HEVC and H.264
    // paths can be exercised on a machine whose GPU has AV1.
    ExportCodec forced = ExportCodec::Av1;
    const bool haveForced = ParseExportCodec(std::getenv("FLASH_EXPORT_CODEC"), forced);
    std::vector<ExportCodec> ladder;
    MfScope mf;
    if ((!haveForced || forced == ExportCodec::Av1) && HasHardwareEncoder(MFVideoFormat_AV1))
        ladder.push_back(ExportCodec::Av1);
    if ((!haveForced || forced != ExportCodec::H264) && HasHardwareEncoder(MFVideoFormat_HEVC))
        ladder.push_back(ExportCodec::Hevc);
    ladder.push_back(ExportCodec::H264);
    return ladder;
}

// Encoder settings the sink writer hands to whichever encoder it creates. All
// of them are requests: an encoder that cannot honour one ignores it, and the
// caller falls back to no settings at all if the set is refused outright.
ComPtr<IMFAttributes> EncoderSettings(const ExportPlan& plan) {
    ComPtr<IMFAttributes> settings;
    Check(MFCreateAttributes(&settings, 7), "MFCreateAttributes(encoder)");
    settings->SetUINT32(CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_PeakConstrainedVBR);
    settings->SetUINT32(CODECAPI_AVEncCommonMeanBitRate, plan.videoKbps * 1000);
    settings->SetUINT32(CODECAPI_AVEncCommonMaxBitRate, plan.videoKbps * 1500);
    settings->SetUINT32(CODECAPI_AVEncMPVDefaultBPictureCount, 2);
    // Four seconds between keyframes: a share copy is watched start to finish,
    // and every keyframe spent on seekability is bits taken from the picture.
    settings->SetUINT32(CODECAPI_AVEncMPVGOPSize, plan.fps * 4);
    settings->SetUINT32(CODECAPI_AVEncCommonQualityVsSpeed, 100);
    if (plan.codec == ExportCodec::H264) settings->SetUINT32(CODECAPI_AVEncH264CABACEnable, TRUE);
    return settings;
}
```

- [ ] **Step 4: Teach `EncodeClip` the codec, the cap and the grid**

All edits are in `EncodeClip` in the same file.

Change its signature from

```cpp
static ExportResult EncodeClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options, ExportPlan& usedPlan, bool retry) {
```

to

```cpp
static ExportResult EncodeClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options, ExportPlan& usedPlan, bool retry, ExportCodec codec) {
```

Replace the line that begins `const ExportPlan plan = retry ? usedPlan : PlanExport(` with:

```cpp
        // The source's overall bitrate caps a size-limited copy: more bits than
        // the original had cannot make it look better.
        const bool limited = options.maxBytes < kExportUnlimitedBytes;
        const uint32_t sourceKbps = limited
            ? static_cast<uint32_t>((std::min)(static_cast<double>(kExportMaxVideoKbps),
                std::filesystem::file_size(input) * 8.0 / 1000.0 / sourceSeconds))
            : 0;
        const ExportPlan plan = retry ? usedPlan : PlanExport(sourceWidth, sourceHeight, fps, span,
            options.maxBytes, options.maxHeight, codec, options.maxFps, sourceKbps);
```

Replace this block:

```cpp
        auto videoTarget = MakeType(MFMediaType_Video, MFVideoFormat_H264);
        Check(MFSetAttributeSize(videoTarget.Get(), MF_MT_FRAME_SIZE, outWidth, outHeight), "target frame size");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_FRAME_RATE, plan.fps, 1), "target frame rate");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "target aspect");
        Check(videoTarget->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "target interlace");
        Check(videoTarget->SetUINT32(MF_MT_AVG_BITRATE, plan.videoKbps * 1000), "target bitrate");
        DWORD videoOut = 0;
        Check(writer->AddStream(videoTarget.Get(), &videoOut), "AddStream(video)");
        Check(writer->SetInputMediaType(videoOut, actualVideo.Get(), nullptr), "SetInputMediaType(video)");
```

with:

```cpp
        auto videoTarget = MakeType(MFMediaType_Video, Subtype(plan.codec));
        Check(MFSetAttributeSize(videoTarget.Get(), MF_MT_FRAME_SIZE, outWidth, outHeight), "target frame size");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_FRAME_RATE, plan.fps, 1), "target frame rate");
        Check(MFSetAttributeRatio(videoTarget.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "target aspect");
        Check(videoTarget->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "target interlace");
        Check(videoTarget->SetUINT32(MF_MT_AVG_BITRATE, plan.videoKbps * 1000), "target bitrate");
        // Without a profile the hardware encoder defaults to Constrained
        // Baseline, which is what made share copies look the way they did.
        if (plan.codec == ExportCodec::H264)
            Check(videoTarget->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High), "target profile");
        // A codec the writer or encoder will not set up is a reason to step
        // down the ladder, not to fail the export. H.264 is the last step, so
        // there it is a real error.
        const auto setup = [&](HRESULT hr, const char* operation) {
            if (SUCCEEDED(hr)) return;
            if (plan.codec != ExportCodec::H264) throw CodecUnavailable(operation);
            Check(hr, operation);
        };
        DWORD videoOut = 0;
        setup(writer->AddStream(videoTarget.Get(), &videoOut), "AddStream(video)");
        if (FAILED(writer->SetInputMediaType(videoOut, actualVideo.Get(), EncoderSettings(plan).Get())))
            setup(writer->SetInputMediaType(videoOut, actualVideo.Get(), nullptr), "SetInputMediaType(video)");
```

Replace `Check(writer->BeginWriting(), "IMFSinkWriter::BeginWriting");` with:

```cpp
        setup(writer->BeginWriting(), "IMFSinkWriter::BeginWriting");
```

Replace `LONGLONG lastEnd = 0, lastSlot = -1;` with:

```cpp
        LONGLONG lastEnd = 0;
        // Below the source rate, frames are re-timed onto an even grid. At the
        // source rate they keep their own timestamps untouched.
        const bool regrid = plan.fps < fps;
        FrameGrid grid{plan.fps};
        const LONGLONG frameTicks = 10000000LL / (std::max)(1u, plan.fps);
```

Replace this block:

```cpp
            const LONGLONG rebased = time - startTicks;
            if (plan.fps < fps) {   // halved rate: keep every other frame
                const LONGLONG slot = rebased / (10000000LL / (std::max)(1u, plan.fps));
                if (slot == lastSlot) continue;
                lastSlot = slot;
            }
            Check(sample->SetSampleTime(rebased), "set video time");
```

with:

```cpp
            LONGLONG rebased = time - startTicks;
            if (regrid) {
                const int64_t slot = grid.Take(rebased / 10);
                if (slot < 0) continue;
                rebased = slot * 10000000LL / plan.fps;
                Check(sample->SetSampleDuration(frameTicks), "set video duration");
            }
            Check(sample->SetSampleTime(rebased), "set video time");
```

After the line `result.bitrateKbps = result.durationSeconds > 0.0` and its continuation line, before `return result;`, add:

```cpp
        result.codec = ExportCodecName(plan.codec);
```

- [ ] **Step 5: Replace `ExportClip` with the ladder and the three-attempt loop**

Replace the whole `ExportClip` function at the bottom of the file with:

```cpp
ExportResult ExportClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options) {
#ifdef _WIN32
    if (inputPath.empty() || outputPath.empty()) throw std::invalid_argument("clip paths must not be empty");
    MediaOutput output(std::filesystem::u8path(outputPath));
    // Each attempt is encoded beside the reserved partial file and only moved
    // onto it when it fits and is the largest so far. That way a retry that
    // overshoots cannot cost the copy that already fit.
    std::filesystem::path attempt = output.Partial();
    attempt += L".try.mp4";
    struct Remove {
        std::filesystem::path path;
        ~Remove() { std::error_code ignored; std::filesystem::remove(path, ignored); }
    } cleanup{attempt};
    const auto utf8 = attempt.u8string();
    const std::string attemptPath(utf8.begin(), utf8.end());

    for (ExportCodec codec : CodecLadder(options.codec)) {
        try {
            ExportPlan plan;
            ExportResult best;
            bool kept = false;
            for (int round = 0; round < 3; ++round) {
                auto result = EncodeClip(inputPath, attemptPath, options, plan, round != 0, codec);
                if (result.bytes <= options.maxBytes && (!kept || result.bytes > best.bytes)) {
                    std::filesystem::rename(attempt, output.Partial());
                    best = result;
                    kept = true;
                }
                if (!ExportNeedsRetry(plan, options.maxBytes, result.bytes)) break;
                plan = RetryExportPlan(plan, options.maxBytes, result.bytes);
                if (!plan.width) break;
            }
            if (!kept) throw std::runtime_error("export still exceeds the requested size budget after retry");
            output.Publish();
            best.filePath = outputPath;
            return best;
        } catch (const CodecUnavailable&) {
            continue;   // next step of the ladder
        }
    }
    throw std::runtime_error("no video encoder accepted the export");
#else
    (void)inputPath; (void)outputPath; (void)options;
    throw std::runtime_error("clip export is only available on Windows");
#endif
}
```

- [ ] **Step 6: Build and run the probes**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm --filter @flash/capture run build
node scripts/probes/share-copy.js "C:/Users/emers/Videos/Flash/Rocket League/2026-10-09_22-15-41.mp4"
```

Expected: three `auto` lines reporting `av1`, each at or under 100% of its limit, then an `h264` line, then `PASS`. The 10MB line should read 1920x1080 and between 88% and 100%. The 4MB line may be at a lower resolution; the 25MB line may be under 88% only if the plan reached the source bitrate.

If `MFVideoFormat_AV1` is an undeclared identifier, the Windows SDK in use predates it. Add this once, inside the anonymous namespace above `Subtype`, and rebuild:

```cpp
// {31305641-0000-0010-8000-00AA00389B71}, FOURCC 'AV01'
const GUID MFVideoFormat_AV1 = {0x31305641, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
```

Now the lower steps of the ladder (PowerShell syntax differs; this is Git Bash):

```bash
FLASH_EXPORT_CODEC=hevc node scripts/probes/share-copy.js "C:/Users/emers/Videos/Flash/Rocket League/2026-10-09_22-15-41.mp4" hevc
FLASH_EXPORT_CODEC=h264 node scripts/probes/share-copy.js "C:/Users/emers/Videos/Flash/Rocket League/2026-10-09_22-15-41.mp4" h264
```

Expected: `PASS` both times, reporting `hevc` and `h264`.

Confirm what the files really are. The probe prints its output folder; for each `.mp4` in it:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,avg_frame_rate,width,height -of csv=p=0 "<file>"
```

Expected: `av1,Main,1920,1080,60/1` for the AV1 10MB copy; `h264,High,...,60/1` for every H.264 copy (never `Constrained Baseline`); `hevc,Main,...` for the HEVC run.

- [ ] **Step 7: Run the existing checks**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm test
FLASH_HARDWARE_TESTS=1 node --experimental-strip-types scripts/probes/export-and-game.js
node scripts/probes/every-native-path.js
```

Expected: `pnpm test` reports no failed checks. `export-and-game.js` prints only `PASS` lines; its line `PASS: measured oversize retries once...` still passes because the "exceeds the requested size budget" message is unchanged. `every-native-path.js` reports the editor-save path passing. If `every-native-path.js` needs arguments, its header comment says which; follow it.

If the hardware `export-and-game.js` run fails with the installed Flash holding the capture hotkeys, quit the installed Flash from the tray and run it again (see the repo's notes on the dev build and installed build conflicting).

- [ ] **Step 8: Commit**

```bash
git add packages/flash-capture/src/platform/windows/clip_exporter.cpp scripts/probes/share-copy.js
git commit -m "feat(export): AV1/HEVC/H.264 High ladder, 60 fps grid and size window on Windows"
```

---

### Task 4: Desktop app

**Files:**
- Create: `apps/desktop/src/shared/exportLimits.ts`
- Create: `apps/desktop/src/shared/exportLimits.test.ts`
- Modify: `apps/desktop/src/main/main.ts` (addon type near line 297, editor save near line 1379, `export-clip` handler near line 1426)
- Modify: `apps/desktop/src/preload/preload.ts` (lines 90 and 184)
- Modify: `apps/desktop/src/renderer/SelectionBar.tsx`
- Modify: `apps/desktop/src/renderer/FeedView.tsx`

**Interfaces:**
- Consumes: the addon's `exportClip` options `codec` and `maxFps` and result field `codec` (Task 2).
- Produces:
  - `exportLimits.ts`: `type ExportCodecChoice = 'auto' | 'h264'`; `interface ExportLimit { value: string; label: string; hint: string; bytes: number; codec: ExportCodecChoice }`; `EXPORT_LIMITS: ExportLimit[]`; `defaultExportLimit(platform?: string): string`; `findExportLimit(id: string): ExportLimit`; `exportSuffix(bytes: number, codec: ExportCodecChoice): string`; `codecNote(requested: ExportCodecChoice, actual?: string): string`.
  - `window.flash.exportClip(filePath: string, maxBytes: number, codec?: ExportCodecChoice)` resolving with an added optional `codec: string`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/shared/exportLimits.test.ts`:

```ts
// Self-check for the share-copy size menu. Run with:
//   node --experimental-strip-types src/shared/exportLimits.test.ts
import { strict as assert } from 'node:assert'
import { EXPORT_LIMITS, codecNote, defaultExportLimit, exportSuffix, findExportLimit } from './exportLimits.ts'

// Every entry is reachable by its id, and ids are unique.
assert.equal(new Set(EXPORT_LIMITS.map(limit => limit.value)).size, EXPORT_LIMITS.length)
for (const limit of EXPORT_LIMITS) assert.equal(findExportLimit(limit.value), limit)

// An id from an older build, or junk, falls back to the first entry.
assert.equal(findExportLimit('nope'), EXPORT_LIMITS[0])
assert.equal(findExportLimit(String(10 * 1048576)), EXPORT_LIMITS[0])

// Windows defaults to the best codec; Linux to the one that plays everywhere there.
assert.equal(findExportLimit(defaultExportLimit('win32')).codec, 'auto')
assert.equal(findExportLimit(defaultExportLimit('linux')).codec, 'h264')
assert.equal(findExportLimit(defaultExportLimit(undefined)).codec, 'auto')
assert.equal(findExportLimit(defaultExportLimit('linux')).bytes, 10 * 1048576)

// The two 10MB copies of one clip get different names.
assert.equal(exportSuffix(10 * 1048576, 'auto'), ' - 10MB.mp4')
assert.equal(exportSuffix(10 * 1048576, 'h264'), ' - 10MB H264.mp4')
assert.equal(exportSuffix(500 * 1048576, 'auto'), ' - 500MB.mp4')

// The note only speaks up when Auto did not get AV1.
assert.equal(codecNote('auto', 'av1'), '')
assert.equal(codecNote('auto', 'hevc'), 'Exported as HEVC (no AV1 encoder on this GPU)')
assert.equal(codecNote('auto', 'h264'), 'Exported as H.264 (no AV1 encoder on this GPU)')
assert.equal(codecNote('h264', 'h264'), '')
assert.equal(codecNote('auto', undefined), '')

console.log('exportLimits self-check passed')
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/apps/desktop"
node --experimental-strip-types src/shared/exportLimits.test.ts
```

Expected: FAIL with `Cannot find module` for `./exportLimits.ts`.

- [ ] **Step 3: Write `exportLimits.ts`**

Create `apps/desktop/src/shared/exportLimits.ts`:

```ts
// The share-copy size menu, shared by the renderer (which shows it) and the
// main process (which names the output file).

export type ExportCodecChoice = 'auto' | 'h264'

export interface ExportLimit {
  value: string
  label: string
  hint: string
  bytes: number
  codec: ExportCodecChoice
}

// Discord's upload ceilings. The tier is the hint rather than part of the
// label, so the size stays the thing you read first. "Compatible" is H.264:
// it plays for a viewer whose PC cannot decode the newer codecs.
export const EXPORT_LIMITS: ExportLimit[] = [
  { value: '10', label: '10MB', hint: 'Discord free', bytes: 10 * 1048576, codec: 'auto' },
  { value: '10-h264', label: '10MB compatible', hint: 'H.264, plays anywhere', bytes: 10 * 1048576, codec: 'h264' },
  { value: '50', label: '50MB', hint: 'Nitro Basic', bytes: 50 * 1048576, codec: 'auto' },
  { value: '500', label: '500MB', hint: 'Nitro', bytes: 500 * 1048576, codec: 'auto' },
]

// Linux starts on the compatible entry: when a Linux GPU has no AV1 encoder,
// the fallback is H.264 either way, and H.264 is what Linux players and Discord
// on Linux reliably decode.
export const defaultExportLimit = (platform: string | undefined): string =>
  platform === 'linux' ? '10-h264' : '10'

export const findExportLimit = (id: string): ExportLimit =>
  EXPORT_LIMITS.find(limit => limit.value === id) ?? EXPORT_LIMITS[0]

export const exportSuffix = (bytes: number, codec: ExportCodecChoice): string =>
  ` - ${Math.round(bytes / 1048576)}MB${codec === 'h264' ? ' H264' : ''}.mp4`

// Says so when "auto" could not use AV1, so a worse-looking copy is explained.
export function codecNote(requested: ExportCodecChoice, actual: string | undefined): string {
  if (requested !== 'auto' || !actual || actual === 'av1') return ''
  return `Exported as ${actual === 'hevc' ? 'HEVC' : 'H.264'} (no AV1 encoder on this GPU)`
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash/apps/desktop"
node --experimental-strip-types src/shared/exportLimits.test.ts
```

Expected: `exportLimits self-check passed`.

- [ ] **Step 5: Main process**

In `apps/desktop/src/main/main.ts`:

Add to the imports from `../shared/...` near the top of the file (match the style of the neighbouring shared imports, which omit the extension):

```ts
import { exportSuffix, type ExportCodecChoice } from '../shared/exportLimits'
```

In the addon interface, change the `exportClip?` declaration's options and result to:

```ts
  exportClip?(input: string, output: string, options: {
    maxBytes: number; maxHeight?: number; startSeconds?: number; endSeconds?: number
    // Gains are keyed by track name so a caller cannot silence the wrong lane
    // by miscounting. Omitting either leaves the export unchanged.
    gains?: { game?: number; mic?: number; other?: number }
    saturation?: number
    // 'auto' takes the best codec the GPU can encode; the result says which.
    codec?: ExportCodecChoice
    maxFps?: number
  }): Promise<{ path: string; duration: number; width: number; height: number; bytes: number; bitrateKbps: number; codec: string }>
```

In the editor save (the `captureAddon.exportClip(filePath, output, {` call that passes `maxBytes: Number.MAX_SAFE_INTEGER`), add one property after `saturation: options.saturation,`:

```ts
          // A saved edit is opened again by the trimmer, which only reads H.264.
          codec: 'h264',
```

Replace the head of the `export-clip` handler, from `ipcMain.handle('export-clip', async (_event, filePath: string, maxBytes: number) => {` through the line `const result = await captureAddon.exportClip(filePath, output, { maxBytes })`, with:

```ts
  ipcMain.handle('export-clip', async (_event, filePath: string, maxBytes: number, requested?: ExportCodecChoice) => {
    if (!captureAddon?.exportClip) return { error: 'This build cannot export clips' }
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { error: 'Export size is not valid' }
    const codec: ExportCodecChoice = requested === 'h264' ? 'h264' : 'auto'
    if (extname(filePath).toLowerCase() !== '.mp4') return { error: 'Only clips can be processed' }
    let reservation: ReturnType<typeof reserveOutput> | undefined
    const requestedPath = filePath.replace(/\.mp4$/i, exportSuffix(maxBytes, codec))
    try {
      reservation = reserveOutput(requestedPath)
      const output = reservation.path
      // 60 fps is the most a chat-window player shows; anything above it is
      // bitrate spent on frames nobody sees.
      const result = await captureAddon.exportClip(filePath, output, { maxBytes, codec, maxFps: 60 })
```

The rest of the handler (sidecar, refresh, `return result`, `catch`, `finally`) stays as it is. Check that no reference to the removed names `mb` or `requested` (the old path variable) remains in that handler.

- [ ] **Step 6: Preload**

In `apps/desktop/src/preload/preload.ts`, change the implementation (near line 90) to:

```ts
  exportClip: (filePath: string, maxBytes: number, codec?: 'auto' | 'h264') =>
    ipcRenderer.invoke('export-clip', filePath, maxBytes, codec),
```

and the type (near line 184) to:

```ts
  exportClip: (filePath: string, maxBytes: number, codec?: 'auto' | 'h264') =>
    Promise<{ path?: string; bytes?: number; width?: number; height?: number; bitrateKbps?: number; codec?: string; error?: string }>
```

- [ ] **Step 7: Selection bar**

In `apps/desktop/src/renderer/SelectionBar.tsx`:

Delete the `EXPORT_LIMITS` constant and the comment above it, and add this import under the `Dropdown` import:

```ts
import { EXPORT_LIMITS, codecNote, defaultExportLimit, findExportLimit } from '../shared/exportLimits'
```

Replace `const [exportBytes, setExportBytes] = useState(10 * 1048576)` with:

```ts
  const [exportLimit, setExportLimit] = useState(() => defaultExportLimit(window.flash?.platform))
```

In `exportSelected`, add after `let failed = 0`:

```ts
    const limit = findExportLimit(exportLimit)
    let fallback = ''
```

Replace

```ts
        const result = await window.flash?.exportClip(clip.filePath, exportBytes)
        if (!result || result.error) failed++
        else exported++
```

with

```ts
        const result = await window.flash?.exportClip(clip.filePath, limit.bytes, limit.codec)
        if (!result || result.error) failed++
        else { exported++; fallback = codecNote(limit.codec, result.codec) || fallback }
```

Replace `setNote(\`Exported ${exported} of ${items.length}${skippedNote}${failedNote}\`)` with:

```ts
    const codecSuffix = fallback ? ` — ${fallback}` : ''
    setNote(`Exported ${exported} of ${items.length}${skippedNote}${failedNote}${codecSuffix}`)
```

In the JSX, change the export `Dropdown` to:

```tsx
            <Dropdown
              value={exportLimit}
              onChange={setExportLimit}
              title="Upload limit to fit under"
              options={EXPORT_LIMITS}
              width={176}
            />
```

and raise the note's `maxWidth: 260` to `maxWidth: 420` so the codec note is not cut off.

- [ ] **Step 8: Watch view**

In `apps/desktop/src/renderer/FeedView.tsx`:

Replace `import { EXPORT_LIMITS } from './SelectionBar'` with:

```ts
import { EXPORT_LIMITS, codecNote, defaultExportLimit, findExportLimit } from '../shared/exportLimits'
```

Replace `const [exportBytes, setExportBytes] = useState(10 * 1048576)   // Discord free tier` with:

```ts
  const [exportLimit, setExportLimit] = useState(() => defaultExportLimit(window.flash?.platform))
```

Replace the body of `exportCopy` from `const result = await window.flash?.exportClip(clip.filePath, exportBytes)` through the `setNote(\`Shareable copy saved...` line with:

```ts
    const limit = findExportLimit(exportLimit)
    const result = await window.flash?.exportClip(clip.filePath, limit.bytes, limit.codec)
    setExportBusy(false)
    if (!result || result.error) { setNote(result?.error ?? 'Export failed'); return }
    const fallback = codecNote(limit.codec, result.codec)
    setNote(`Shareable copy saved: ${formatBytes(result.bytes ?? 0)} at ${result.height}p${fallback ? `. ${fallback}` : ''}`)
```

In the JSX, change the export button's `title` to:

```tsx
                title={`Make a copy under ${findExportLimit(exportLimit).label} to send in Discord`}>
```

and the `Dropdown` to:

```tsx
              <Dropdown value={exportLimit} onChange={setExportLimit} title="Upload limit to fit under"
                options={EXPORT_LIMITS} width={150} variant="joined" />
```

- [ ] **Step 9: Typecheck and test**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm typecheck && pnpm test
```

Expected: no type errors; `exportLimits.test.ts` listed as `pass`; no failed checks. A leftover `exportBytes` or `setExportBytes` reference is a type error here; replace it with the `exportLimit` equivalent.

- [ ] **Step 10: See it in the running app**

Quit the installed Flash from the tray first; it takes the hotkeys from the dev build. Then start the dev build with the launch configuration the repo already uses (`.claude/launch.json`; see `docs/` notes on running the dev window) and check in the Watch view and with two clips selected in the Library:

- The size menu lists `10MB`, `10MB compatible`, `50MB`, `500MB`, and no label is clipped at the new widths.
- Exporting at `10MB` adds `<clip> - 10MB.mp4`; at `10MB compatible` adds `<clip> - 10MB H264.mp4`; both exist together.
- The note after a `10MB` export has no codec remark on this machine.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/shared/exportLimits.ts apps/desktop/src/shared/exportLimits.test.ts apps/desktop/src/main/main.ts apps/desktop/src/preload/preload.ts apps/desktop/src/renderer/SelectionBar.tsx apps/desktop/src/renderer/FeedView.tsx
git commit -m "feat(export): size menu carries a codec; compatible H.264 entry"
```

---

### Task 5: Linux exporter

Nothing in this task can be compiled or run on the development machine. Write it exactly, re-read it against the surrounding code, and rely on the Ubuntu CI job to compile it once the branch is pushed (pushing is the user's call, not part of this task). Do not mark any Linux behaviour as verified.

**Files:**
- Modify: `packages/flash-capture/src/core/encoder.h` (`EncoderConfig`)
- Modify: `packages/flash-capture/src/platform/linux/libav_encoder.cpp` (`LibavEncoder::Initialize`)
- Modify: `packages/flash-capture/src/platform/linux/libav_muxer.cpp` (`Write`, `Export`)
- Modify: `scripts/build-linux-media.sh`
- Modify: `docs/linux.md`

**Interfaces:**
- Consumes: everything Task 1 produces; `ExportCodecChoice`, `ExportOptions::codec`, `ExportOptions::maxFps`, `ExportResult::codec` from Task 2.
- Produces: `EncoderConfig::codec` (`std::string`, default `"h264"`) and `EncoderConfig::exportQuality` (`bool`, default `false`). Windows encoders ignore both. `FLASH_EXPORT_CODEC` works as on Windows, with `hevc` treated as `h264` on Linux.

- [ ] **Step 1: Encoder config fields**

In `packages/flash-capture/src/core/encoder.h`, inside `EncoderConfig`, after the `preset` line, add:

```cpp
    // Linux file exports only. The capture path leaves both at their defaults.
    std::string codec = "h264";   // "h264" or "av1"
    bool exportQuality = false;   // quality over latency: lookahead, VBR with a peak, longer GOP
```

- [ ] **Step 2: Encoder selection and export tuning**

In `packages/flash-capture/src/platform/linux/libav_encoder.cpp`, in `LibavEncoder::Initialize`:

Replace the line

```cpp
        for (const char* name : {"h264_vaapi", "h264_nvenc", "libopenh264"}) {
```

with

```cpp
        // AV1 is hardware only: there is no software AV1 encoder in the build,
        // so a machine without one returns false and the exporter steps down.
        const std::vector<const char*> names = config.codec == "av1"
            ? std::vector<const char*>{"av1_vaapi", "av1_nvenc"}
            : std::vector<const char*>{"h264_vaapi", "h264_nvenc", "libopenh264"};
        for (const char* name : names) {
```

Replace the line

```cpp
            context_->bit_rate = config.bitrate; context_->gop_size = config.fps * 2; context_->max_b_frames = 0;
```

with

```cpp
            // B-frames stay off for exports too: the muxer takes a clip's end
            // from the last packet in decode order, untested with reordering.
            context_->bit_rate = config.bitrate; context_->max_b_frames = 0;
            context_->gop_size = config.fps * (config.exportQuality ? 4 : 2);
            const bool hardware = name_ != "libopenh264";
            if (config.exportQuality && hardware) {
                context_->rc_max_rate = static_cast<int64_t>(config.bitrate) * 3 / 2;
                context_->rc_buffer_size = static_cast<int>(config.bitrate) * 2;
                if (config.codec == "h264") context_->profile = AV_PROFILE_H264_HIGH;
            }
```

Replace both occurrences of `name_ == "h264_vaapi"` in the two lines that set and test `context_->pix_fmt`:

```cpp
            context_->pix_fmt = name_ == "h264_vaapi" ? AV_PIX_FMT_VAAPI : AV_PIX_FMT_YUV420P;
```

becomes

```cpp
            const bool vaapi = name_.find("_vaapi") != std::string::npos;
            context_->pix_fmt = vaapi ? AV_PIX_FMT_VAAPI : AV_PIX_FMT_YUV420P;
```

Replace the two lines

```cpp
            av_opt_set(context_->priv_data, "forced-idr", "1", 0);
            av_opt_set(context_->priv_data, "rc-lookahead", "0", 0);
```

with

```cpp
            av_opt_set(context_->priv_data, "forced-idr", "1", 0);
            if (config.exportQuality && name_.find("_nvenc") != std::string::npos) {
                // Options an encoder does not have are ignored by av_opt_set.
                av_opt_set(context_->priv_data, "preset", "p7", 0);
                av_opt_set(context_->priv_data, "tune", "hq", 0);
                av_opt_set(context_->priv_data, "rc", "vbr", 0);
                av_opt_set(context_->priv_data, "rc-lookahead", "32", 0);
            } else if (!config.exportQuality) {
                av_opt_set(context_->priv_data, "rc-lookahead", "0", 0);
            }
```

Add `#include <string>` and `#include <vector>` to the file's standard includes if they are not already there.

- [ ] **Step 3: Let the muxer write AV1**

In `packages/flash-capture/src/platform/linux/libav_muxer.cpp`, the `Write` override hard-codes H.264. Rename the existing method and give it a codec, then add a forwarding `Write`.

Change the existing signature

```cpp
    ClipMetadata Write(const std::string& path, const std::vector<EncodedPacket>& video,
        const std::vector<AudioData>& audio, uint32_t width, uint32_t height, uint32_t fps, const std::string& game) override {
```

to

```cpp
    ClipMetadata Write(const std::string& path, const std::vector<EncodedPacket>& video,
        const std::vector<AudioData>& audio, uint32_t width, uint32_t height, uint32_t fps, const std::string& game) override {
        return WriteCodec(path, video, audio, width, height, fps, game, AV_CODEC_ID_H264);
    }
    // Saved clips are always H.264; a share copy may be AV1. The MP4 muxer
    // builds either codec's configuration record from the first keyframe.
    ClipMetadata WriteCodec(const std::string& path, const std::vector<EncodedPacket>& video,
        const std::vector<AudioData>& audio, uint32_t width, uint32_t height, uint32_t fps, const std::string& game,
        AVCodecID videoCodec) {
```

and in the body that now belongs to `WriteCodec`, change `parameters->codec_id = AV_CODEC_ID_H264;` to `parameters->codec_id = videoCodec;`.

- [ ] **Step 4: Replace `Export` with the ladder and the three-attempt loop**

In the same file, replace the whole `Export` override (from `ExportResult Export(const std::string& input, const std::string& output, const ExportOptions& options) override {` through its closing brace, the one just before `SavePng` or the PNG code that begins `const auto* codec = avcodec_find_encoder_by_name("png")`) with:

```cpp
    // Thrown when no encoder exists for the plan's codec, so Export can step down.
    struct NoEncoder {};

    static std::vector<ExportCodec> ExportLadder(ExportCodecChoice choice) {
        if (choice == ExportCodecChoice::H264) return {ExportCodec::H264};
        // Linux skips HEVC: Chromium here decodes it only through VA-API, so an
        // HEVC copy is often a black frame in Flash's player and in Discord.
        ExportCodec forced = ExportCodec::Av1;
        if (ParseExportCodec(std::getenv("FLASH_EXPORT_CODEC"), forced) && forced != ExportCodec::Av1)
            return {ExportCodec::H264};
        return {ExportCodec::Av1, ExportCodec::H264};
    }

    // One encode at a fixed plan, written to encodedPath (which must not exist).
    ExportResult ExportOnce(const std::string& input, const std::string& encodedPath, const ExportOptions& options,
                            const ExportPlan& plan, int64_t end) {
        Media media; media.Open(input); const int index = av_find_best_stream(media.input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        Check(index, "Find export video"); auto* stream = media.input->streams[index]; media.Decoder(index);
        const uint32_t sourceFps = static_cast<uint32_t>(std::max(1, static_cast<int>(av_q2d(stream->avg_frame_rate) + 0.5)));
        EncoderConfig config; config.width = plan.width; config.height = plan.height; config.fps = plan.fps; config.bitrate = plan.videoKbps * 1000;
        config.codec = ExportCodecName(plan.codec); config.exportQuality = true;
        auto encoder = CreateEncoder(config); if (!encoder) throw NoEncoder{};
        std::vector<EncodedPacket> encoded; std::vector<uint8_t> pixels(static_cast<size_t>(plan.width) * plan.height * 4);
        // Below the source rate, frames are re-timed onto an even grid. At the
        // source rate they keep their own timestamps.
        const bool regrid = plan.fps < sourceFps; FrameGrid grid{plan.fps};
        auto receive = [&] {
            int result;
            while ((result = avcodec_receive_frame(media.codec, media.frame)) == 0) {
                auto time = av_rescale_q(media.frame->best_effort_timestamp, stream->time_base, micros);
                bool keep = time >= options.startUs && time < end;
                if (keep && regrid) {
                    const int64_t slot = grid.Take(time - options.startUs);
                    keep = slot >= 0;
                    if (keep) time = options.startUs + slot * 1000000 / plan.fps;
                }
                if (keep) {
                    media.scaler = sws_getCachedContext(media.scaler, media.frame->width, media.frame->height,
                        static_cast<AVPixelFormat>(media.frame->format), plan.width, plan.height, AV_PIX_FMT_BGR0, SWS_BICUBIC, nullptr, nullptr, nullptr);
                    if (!media.scaler) throw std::runtime_error("Export conversion unavailable");
                    uint8_t* dest[] = {pixels.data()}; int strides[] = {static_cast<int>(plan.width * 4)};
                    sws_scale(media.scaler, media.frame->data, media.frame->linesize, 0, media.frame->height, dest, strides);
                    if (options.saturation != 100) for (size_t i = 0; i < pixels.size(); i += 4) {
                        const double luma = 0.0722 * pixels[i] + 0.7152 * pixels[i + 1] + 0.2126 * pixels[i + 2];
                        for (size_t c = 0; c < 3; ++c) pixels[i + c] = static_cast<uint8_t>(std::clamp(luma +
                            (pixels[i + c] - luma) * options.saturation / 100.0, 0.0, 255.0));
                    }
                    FrameData frame{}; frame.data = pixels.data(); frame.width = plan.width; frame.height = plan.height;
                    frame.stride = plan.width * 4; frame.timestamp_us = time;
                    if (!encoder->EncodeFrame(frame, encoded)) throw std::runtime_error("Export encoding failed");
                }
                av_frame_unref(media.frame);
            }
            if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) Check(result, "Decode export video");
        };
        while (av_read_frame(media.input, media.packet) >= 0) {
            if (media.packet->stream_index == index) { Check(avcodec_send_packet(media.codec, media.packet), "Send export video"); receive(); }
            av_packet_unref(media.packet);
        }
        Check(avcodec_send_packet(media.codec, nullptr), "Drain export decoder"); receive();
        if (!encoder->Drain(encoded)) throw std::runtime_error("Could not drain export encoder");
        if (encoded.empty()) throw std::runtime_error("Export range contains no video");
        const auto start = encoded.front().pts_us;
        std::vector<float> mixed(static_cast<size_t>(av_rescale(end - start, 48000, 1000000)) * 2, 0);
        for (const auto& track : DecodePcm(input, 48000, 2)) {
            const float gain = options.gains[track.id == "game" ? 0 : track.id == "mic" ? 1 : 2];
            const auto offset = static_cast<size_t>(av_rescale(start, 48000, 1000000)) * 2;
            for (size_t i = 0; i < mixed.size() && offset + i < track.samples.size(); ++i) mixed[i] += track.samples[offset + i] * gain;
        }
        for (auto& sample : mixed) sample = std::clamp(sample, -1.0f, 1.0f);
        AudioData audio{mixed.data(), static_cast<uint32_t>(mixed.size() / 2), 2, 48000, start, "other"};
        auto metadata = WriteCodec(encodedPath, encoded, {audio}, plan.width, plan.height, plan.fps, "",
            plan.codec == ExportCodec::Av1 ? AV_CODEC_ID_AV1 : AV_CODEC_ID_H264);
        return {"", metadata.durationSeconds, plan.width, plan.height, std::filesystem::file_size(encodedPath),
            plan.videoKbps, ExportCodecName(plan.codec)};
    }

    ExportResult Export(const std::string& input, const std::string& output, const ExportOptions& options) override {
        uint32_t width = 0, height = 0, fps = 30;
        {
            Media probe; probe.Open(input); const int index = av_find_best_stream(probe.input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
            Check(index, "Find export video"); probe.Decoder(index);
            width = probe.codec->width; height = probe.codec->height;
            fps = static_cast<uint32_t>(std::max(1, static_cast<int>(av_q2d(probe.input->streams[index]->avg_frame_rate) + 0.5)));
        }
        const int64_t last = ScanVideo(input).lastTimeUs;
        const int64_t end = options.endUs ? options.endUs : last;
        // The source's overall bitrate caps a size-limited copy.
        const uint32_t sourceKbps = options.maxBytes < kExportUnlimitedBytes && last > 0
            ? static_cast<uint32_t>(std::min(static_cast<double>(kExportMaxVideoKbps),
                std::filesystem::file_size(input) * 8.0 / 1000.0 / (last / 1000000.0)))
            : 0;
        // Each attempt is encoded beside the staged file and only moved onto it
        // when it fits and is the largest so far, so a retry that overshoots
        // cannot cost the copy that already fit.
        OutputFile staged(output);
        const std::string encodedPath = staged.Path() + ".mp4";
        struct Remove { std::string path; ~Remove() { std::error_code error; std::filesystem::remove(path, error); } } cleanup{encodedPath};
        for (ExportCodec codec : ExportLadder(options.codec)) {
            ExportPlan plan = PlanExport(width, height, fps, (end - options.startUs) / 1000000.0, options.maxBytes,
                options.maxHeight, codec, options.maxFps, sourceKbps);
            if (!plan.videoKbps) throw std::runtime_error("Export budget is too small");
            ExportResult best; bool kept = false;
            try {
                for (int round = 0; round < 3 && plan.width; ++round) {
                    std::error_code ignored; std::filesystem::remove(encodedPath, ignored);
                    auto result = ExportOnce(input, encodedPath, options, plan, end);
                    if (result.bytes <= options.maxBytes && (!kept || result.bytes > best.bytes)) {
                        std::filesystem::rename(encodedPath, staged.Path()); best = result; kept = true;
                    }
                    if (!ExportNeedsRetry(plan, options.maxBytes, result.bytes)) break;
                    plan = RetryExportPlan(plan, options.maxBytes, result.bytes);
                }
            } catch (const NoEncoder&) { continue; }   // next step of the ladder
            if (!kept) throw std::runtime_error("Encoded export exceeds the requested size budget");
            staged.Publish(); best.filePath = output; return best;
        }
        throw std::runtime_error("No LGPL video encoder available");
    }
```

Add `#include <cstdlib>` to the file's standard includes if it is not there, and confirm the file already includes `../../core/export_budget.h` and `../../core/clip_exporter.h` (directly or through `linux_backend.h`); add them if not.

Re-read the result against these four things, since no compiler will: every name used (`Media`, `Check`, `micros`, `DecodePcm`, `ScanVideo`, `OutputFile`, `ClipMetadata::durationSeconds`) exists earlier in the file with the shape used here; `ExportOnce` and `WriteCodec` are members of `LibavMuxer`, declared before `Export`; the old single-attempt `Export` body is completely gone; and braces balance.

- [ ] **Step 5: Build recipe**

In `scripts/build-linux-media.sh`, change

```
  --enable-encoder=h264_vaapi,h264_nvenc,libopenh264,aac,png \
```

to

```
  --enable-encoder=h264_vaapi,h264_nvenc,av1_vaapi,av1_nvenc,libopenh264,aac,png \
```

- [ ] **Step 6: Linux documentation**

In `docs/linux.md`:

In the "Current state" table, replace the H.264 row with:

```
| Video encoding | Capture: probe `h264_vaapi`, then `h264_nvenc`, then `libopenh264`; closed GOP, no B-frames, two-second GOP. Share copies: `av1_vaapi`, then `av1_nvenc`, then the H.264 order, with High profile, a four-second GOP and a bitrate peak on the hardware encoders | Driver compatibility, inline SPS/PPS at every IDR, latency, colour, long recordings; AV1 in MP4 playback; size window accuracy per encoder |
```

After the paragraph that begins "OpenH264 may require the distro's Cisco OpenH264 repository", add:

```
### Share copies and GPU encoders

A share copy uses AV1 when the GPU can encode it (NVIDIA RTX 40 series, AMD RX 7000 series and Ryzen 7040-series graphics, Intel Arc and Core Ultra, or newer), and H.264 otherwise. HEVC is not used on Linux: Chromium decodes it only through VA-API, so it often does not play in Flash or in Discord.

Without a GPU encoder Flash falls back to OpenH264, which is Constrained Baseline and looks visibly worse at the same size. Whether the GPU encoders are present depends on the distro's drivers. This table has not been confirmed on hardware and is part of L2.

| Distro family | GPU | AV1 encode (recent GPU) | H.264 encode |
| --- | --- | --- | --- |
| Any | NVIDIA proprietary driver | NVENC | NVENC |
| Debian, Ubuntu, Arch, SteamOS and derivatives | AMD or Intel | VA-API | VA-API |
| Fedora, openSUSE and derivatives | AMD (Mesa) | VA-API | Off by default; install `mesa-va-drivers-freeworld` from RPM Fusion (Fedora) or the Packman Mesa packages (openSUSE) |
| Fedora | Intel | Needs `intel-media-driver` from RPM Fusion | Same |

`vainfo` lists what the driver offers; an entry ending `EncSlice` for `VAProfileAV1Profile0` or `VAProfileH264High` means that encoder is available. Setting `FLASH_EXPORT_CODEC=h264` in the environment makes share copies skip AV1, for testing the fallback.
```

In the "Next phases" list, append to the **L2** item, before its final sentence:

```
 Run a share-copy export per distro family and GPU vendor: confirm the codec chosen, that the file plays in Flash and in Discord, and that it lands between 88% and 100% of the limit; then decide whether B-frames can be enabled for exports.
```

- [ ] **Step 7: Check what can be checked here**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
pnpm --filter @flash/capture run build && pnpm test
bash -n scripts/build-linux-media.sh && echo "script syntax ok"
```

Expected: the Windows addon still builds (it compiles `encoder.h` with the new fields), all checks pass, and `script syntax ok`. This says nothing about the Linux sources, which the Windows build does not compile.

- [ ] **Step 8: Commit**

```bash
git add packages/flash-capture/src/core/encoder.h packages/flash-capture/src/platform/linux/libav_encoder.cpp packages/flash-capture/src/platform/linux/libav_muxer.cpp scripts/build-linux-media.sh docs/linux.md
git commit -m "feat(linux): AV1 share copies, export-tuned encoder and size window (uncompiled, for CI)"
```

---

### Task 6: Acceptance

**Files:**
- Create: `Flash-compare/E - Flash AV1 1080p60.mp4` and `Flash-compare/F - Flash H264 compatible.mp4` (in `C:/Users/emers/Downloads/Daddy Claude/Flash-compare`, outside the repo; not committed)

**Interfaces:**
- Consumes: the finished Windows build from Tasks 1 to 4.
- Produces: files for the user to judge, and a written result for each manual check in the spec.

- [ ] **Step 1: Produce Flash's own copies of the reference clip**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash"
node -e "
const path=require('node:path');
const addon=require(path.resolve('packages/flash-capture/build/Release/flash_capture.node'));
const src='C:/Users/emers/Videos/Flash/Rocket League/2026-10-09_22-15-41.mp4';
const dir='C:/Users/emers/Downloads/Daddy Claude/Flash-compare/';
(async()=>{
  for (const [name,codec] of [['E - Flash AV1 1080p60.mp4','auto'],['F - Flash H264 compatible.mp4','h264']]) {
    const r=await addon.exportClip(src,dir+name,{maxBytes:10*1024*1024,codec,maxFps:60});
    console.log(name,r.codec,r.width+'x'+r.height,(r.bytes/1048576).toFixed(2)+' MiB');
  }
})().catch(e=>{console.error(e.message);process.exit(1)});
"
```

Expected: two lines, `av1 1920x1080` and `h264 1280x720`, each between 8.8 and 10.0 MiB. If either file already exists the addon refuses; delete the old one and run again.

- [ ] **Step 2: Measure them**

```bash
cd "C:/Users/emers/Downloads/Daddy Claude/Flash-compare"
for f in "E - Flash AV1 1080p60.mp4" "F - Flash H264 compatible.mp4"; do
  echo "$f: $(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,width,height,avg_frame_rate -of csv=p=0 "$f") $(stat -c %s "$f") bytes"
done
```

Expected: `av1,Main,1920,1080,60/1` and `h264,High,1280,720,60/1`. Record the exact output in the hand-off message.

- [ ] **Step 3: Editor refuses a non-H.264 copy politely**

With the dev build running (installed Flash quit), copy `E - Flash AV1 1080p60.mp4` into `C:/Users/emers/Videos/Flash/Rocket League/`, open it in the editor and try a trim. Expected: a readable error message in the editor, the app keeps running. Remove the copied file afterwards. If the app crashes or shows nothing, stop and report it; fixing the trimmer's message is in scope, changing what it accepts is not.

- [ ] **Step 4: Hand off to the user**

Report, with the measured numbers: what `E` and `F` are, how `E` compares in size to `D - AV1 1080p60.mp4`, the results of every probe run in Task 3, that Linux code is written but uncompiled and unrun, and that two checks need the user: watching `E` next to `D`, and dropping `E` into Discord to confirm it plays inline. Do not describe the work as finished before the user has done those two.
