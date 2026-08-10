# Clip editor native foundation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four native capabilities the clip editor needs — per-track audio decode, frame-exact trim planning, frame-exact trim execution, and gain plus saturation on save.

**Architecture:** Pure, testable logic lives in headers next to the existing `quality.h` and `export_budget.h`, which are already header-only and unit-tested. Media Foundation I/O lives in matching `.cpp` files and is exercised by hand, not by unit tests. The N-API surface in `binding.cpp` gains one new function and two new option fields.

**Tech Stack:** C++20, MSVC, Media Foundation, node-addon-api (NAPI_VERSION 8), CMake.

## Global constraints

- C++20. `set(CMAKE_CXX_STANDARD 20)` is already configured — do not change it.
- MSVC builds with `/W4 /EHsc` and `NOMINMAX`. New code must compile warning-free at `/W4`.
- **No new third-party dependencies.** Everything here is Media Foundation and the standard library.
- All Windows code sits behind `#ifdef _WIN32` with a non-Windows fallback that returns `false` or throws, matching the existing files.
- Tests are standalone executables: `int main()` plus `<cassert>`, no framework. Register each in `CMakeLists.txt` with `EXCLUDE_FROM_ALL`.
- Wrap `std::min` / `std::max` in parentheses — `(std::min)(a, b)` — because `NOMINMAX` is defined but Windows headers still fight over it. The existing code does this; match it.
- Commit messages follow the existing convention: `feat(capture):`, `fix(capture):`, `test(capture):`.
- Audio track order is fixed by `kAudioTrackOrder` in `src/buffer/audio_tracks.h`: `{"game", "mic", "other"}`. Never reorder or re-derive it.
- Flash records BT.709 limited range. Colour handling belongs to `src/color_space.h`; do not introduce a second colour path.

---

## File structure

**Created:**

| File | Responsibility |
|---|---|
| `src/buffer/audio_decode.h` | Pure downmix and resample math, plus the `DecodeClipAudio` declaration |
| `src/buffer/audio_decode.cpp` | Media Foundation decode of every audio track into separate buffers |
| `src/buffer/smart_render.h` | Pure planner: given keyframes and a trim range, decide what to re-encode and what to copy |
| `src/buffer/smart_render.cpp` | Executes the plan: encodes the head fragment, splices it onto the copied body |
| `test/audio_decode_test.cpp` | Covers the downmix and resample math |
| `test/smart_render_test.cpp` | Covers the planner |

**Modified:**

| File | Change |
|---|---|
| `src/buffer/clip_trimmer.cpp` | Route through the smart-render planner instead of hard-failing off-keyframe |
| `src/buffer/clip_exporter.cpp` | Accept per-track gains and a saturation value |
| `src/buffer/export_budget.h` | Add `gains` and `saturation` to the options struct |
| `src/binding.cpp` | Expose `decodeClipAudio`; add the two new option fields |
| `CMakeLists.txt` | Add two sources and two test targets |

---

## Task 1: Decode each audio track separately

The renderer needs `game`, `mic` and `other` as independent buffers so Web Audio can mix them live. Chromium's `<video>` decodes only the first audio track, so this has to happen natively.

Preview audio is mono at 22050 Hz. That is enough to judge a mix and to draw waveforms, and it keeps a 5-minute clip near 26 MB across three tracks instead of roughly 345 MB at full stereo rate.

**Files:**
- Create: `packages/flash-capture/src/buffer/audio_decode.h`
- Create: `packages/flash-capture/src/buffer/audio_decode.cpp`
- Test: `packages/flash-capture/test/audio_decode_test.cpp`
- Modify: `packages/flash-capture/CMakeLists.txt`

**Interfaces:**
- Consumes: `kAudioTrackOrder` from `src/buffer/audio_tracks.h`.
- Produces:
  - `float flash::DownmixToMono(const float* frame, uint32_t channels)`
  - `void flash::ResampleLinear(const std::vector<float>& source, uint32_t sourceRate, uint32_t targetRate, std::vector<float>& out)`
  - `struct flash::DecodedTrack { std::string id; std::vector<float> samples; }`
  - `std::vector<flash::DecodedTrack> flash::DecodeClipAudio(const std::string& path, uint32_t targetRate)`

- [ ] **Step 1: Write the failing test**

Create `test/audio_decode_test.cpp`:

```cpp
#include "../src/buffer/audio_decode.h"
#include <cassert>
#include <cmath>

static bool Near(float a, float b) { return std::fabs(a - b) < 1e-5f; }

int main() {
    // Downmix averages the channels rather than summing them, so a mono
    // preview of a stereo track does not clip.
    const float stereo[2] = {0.5f, -0.5f};
    assert(Near(flash::DownmixToMono(stereo, 2), 0.0f));
    const float loud[2] = {1.0f, 1.0f};
    assert(Near(flash::DownmixToMono(loud, 2), 1.0f));
    const float mono[1] = {0.25f};
    assert(Near(flash::DownmixToMono(mono, 1), 0.25f));

    // Halving the rate halves the sample count and keeps the endpoints.
    std::vector<float> source{0.0f, 1.0f, 0.0f, -1.0f};
    std::vector<float> out;
    flash::ResampleLinear(source, 48000, 24000, out);
    assert(out.size() == 2);
    assert(Near(out[0], 0.0f));

    // Same rate in and out is a copy, not a rebuild.
    flash::ResampleLinear(source, 48000, 48000, out);
    assert(out.size() == source.size());
    assert(Near(out[3], -1.0f));

    // Interpolation lands between neighbours, never outside them.
    std::vector<float> ramp{0.0f, 1.0f};
    flash::ResampleLinear(ramp, 2, 4, out);
    for (float v : out) assert(v >= 0.0f && v <= 1.0f);

    // Degenerate input must not divide by zero or read off the end.
    std::vector<float> empty;
    flash::ResampleLinear(empty, 48000, 22050, out);
    assert(out.empty());
    flash::ResampleLinear(source, 0, 22050, out);
    assert(out.empty());
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cmake --build build --target flash_audio_decode_test --config Release
```

Expected: compile failure, `cannot open source file "../src/buffer/audio_decode.h"`.

- [ ] **Step 3: Write the header**

Create `src/buffer/audio_decode.h`:

```cpp
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace flash {

struct DecodedTrack {
    std::string id;
    std::vector<float> samples;
};

// Averaged, not summed: three tracks are mixed downstream and summing here
// would clip before the mixer ever sees the signal.
inline float DownmixToMono(const float* frame, uint32_t channels) {
    if (!frame || !channels) return 0.0f;
    float total = 0.0f;
    for (uint32_t c = 0; c < channels; ++c) total += frame[c];
    return total / static_cast<float>(channels);
}

// Linear interpolation. Preview audio only, so quality past this is wasted.
inline void ResampleLinear(const std::vector<float>& source, uint32_t sourceRate,
                           uint32_t targetRate, std::vector<float>& out) {
    out.clear();
    if (source.empty() || !sourceRate || !targetRate) return;
    if (sourceRate == targetRate) { out = source; return; }
    const double ratio = static_cast<double>(sourceRate) / targetRate;
    const size_t count = static_cast<size_t>(source.size() / ratio);
    out.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        const double at = i * ratio;
        const size_t index = static_cast<size_t>(at);
        const double fraction = at - index;
        const float a = source[index];
        const float b = index + 1 < source.size() ? source[index + 1] : a;
        out.push_back(static_cast<float>(a + (b - a) * fraction));
    }
}

// Returns one entry per audio track present in the clip, in kAudioTrackOrder.
// Tracks that fail to decode are returned empty rather than omitted, so the
// caller can still map results onto lanes by index.
std::vector<DecodedTrack> DecodeClipAudio(const std::string& path, uint32_t targetRate);

} // namespace flash
```

- [ ] **Step 4: Register the test target**

In `CMakeLists.txt`, after the `flash_color_space_test` block:

```cmake
add_executable(flash_audio_decode_test EXCLUDE_FROM_ALL test/audio_decode_test.cpp)
if(MSVC)
  target_compile_options(flash_audio_decode_test PRIVATE /EHsc)
  target_compile_definitions(flash_audio_decode_test PRIVATE NOMINMAX)
endif()
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cmake --build build --target flash_audio_decode_test --config Release
```

Then run `build/Release/flash_audio_decode_test.exe` and confirm exit code 0.

- [ ] **Step 6: Implement the decode**

Create `src/buffer/audio_decode.cpp`. Model it on the reader setup in `clip_exporter.cpp` — same `MFCreateSourceReaderFromURL`, same `MFAudioFormat_Float` request per stream — but keep the tracks separate instead of summing into one buffer.

Requirements:
- Request `MFAudioFormat_Float` on each audio stream, read the stream's actual channel count and sample rate back from `GetCurrentMediaType`, and do not assume they match across tracks.
- Downmix each frame with `DownmixToMono`, then resample the whole track to `targetRate` with `ResampleLinear`.
- Assign ids by position using `kAudioTrackOrder`. A clip with two audio streams yields `game` and `mic`.
- A stream that cannot be decoded produces an entry with the right id and an empty `samples` vector.
- Wrap the body in `#ifdef _WIN32`; the fallback returns an empty vector.
- Start and shut down Media Foundation with a scope guard, the way `clip_trimmer.cpp` does with `MfScope`.

- [ ] **Step 7: Add the source to the addon build**

In `CMakeLists.txt`, add `src/buffer/audio_decode.cpp` to `CAPTURE_SOURCES`.

- [ ] **Step 8: Verify the addon still builds**

```bash
pnpm --filter "@flash/capture" run build
```

Expected: `flash_capture.node` links with no `/W4` warnings from the new file.

- [ ] **Step 9: Commit**

```bash
git add packages/flash-capture/src/buffer/audio_decode.h packages/flash-capture/src/buffer/audio_decode.cpp packages/flash-capture/test/audio_decode_test.cpp packages/flash-capture/CMakeLists.txt
git commit -m "feat(capture): decode clip audio tracks separately for preview"
```

---

## Task 2: Plan a frame-exact trim

The trimmer currently refuses any in-point that is not a keyframe. This planner decides, for an arbitrary in-point, which span must be re-encoded and where the untouched copy begins.

Background the implementer needs: the tail is already frame-exact. `clip_trimmer.cpp` stops on `time >= requestedEnd`, and both encoders set `AVLowLatencyMode`, which disables B-frames — no frame references a later frame, so the stream can be cut at any sample. Only the head needs work.

**Files:**
- Create: `packages/flash-capture/src/buffer/smart_render.h`
- Test: `packages/flash-capture/test/smart_render_test.cpp`
- Modify: `packages/flash-capture/CMakeLists.txt`

**Interfaces:**
- Produces:
  - `struct flash::SmartRenderPlan { bool needsHeadEncode; int64_t headStartUs; int64_t headEndUs; int64_t copyStartUs; }`
  - `flash::SmartRenderPlan flash::PlanSmartRender(const std::vector<int64_t>& keyframesUs, int64_t startUs, int64_t endUs)`

- [ ] **Step 1: Write the failing test**

Create `test/smart_render_test.cpp`:

```cpp
#include "../src/buffer/smart_render.h"
#include <cassert>

int main() {
    // Keyframes every two seconds, matching a GOP of fps * 2.
    const std::vector<int64_t> keys{0, 2000000, 4000000, 6000000, 8000000};

    // An in-point already on a keyframe needs no encode at all: the whole
    // save stays a pure remux.
    auto onKey = flash::PlanSmartRender(keys, 4000000, 7000000);
    assert(!onKey.needsHeadEncode);
    assert(onKey.copyStartUs == 4000000);

    // An in-point mid-GOP re-encodes from the in-point to the next keyframe,
    // then copies from that keyframe on.
    auto midGop = flash::PlanSmartRender(keys, 5000000, 7000000);
    assert(midGop.needsHeadEncode);
    assert(midGop.headStartUs == 5000000);
    assert(midGop.headEndUs == 6000000);
    assert(midGop.copyStartUs == 6000000);

    // When no keyframe follows the in-point, the head runs to the out-point
    // and nothing is copied.
    auto noFollowing = flash::PlanSmartRender(keys, 8500000, 9000000);
    assert(noFollowing.needsHeadEncode);
    assert(noFollowing.headStartUs == 8500000);
    assert(noFollowing.headEndUs == 9000000);
    assert(noFollowing.copyStartUs == 9000000);

    // The next keyframe past the out-point must not extend the head beyond it.
    auto shortRange = flash::PlanSmartRender(keys, 3000000, 3500000);
    assert(shortRange.needsHeadEncode);
    assert(shortRange.headEndUs == 3500000);
    assert(shortRange.copyStartUs == 3500000);

    // No keyframe list at all: encode the whole range rather than emit a
    // plan that copies undecodable bytes.
    auto empty = flash::PlanSmartRender({}, 1000000, 2000000);
    assert(empty.needsHeadEncode);
    assert(empty.headStartUs == 1000000);
    assert(empty.headEndUs == 2000000);

    // An inverted range yields an empty plan, never a negative span.
    auto inverted = flash::PlanSmartRender(keys, 5000000, 4000000);
    assert(!inverted.needsHeadEncode);
    assert(inverted.headStartUs == inverted.headEndUs);
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cmake --build build --target flash_smart_render_test --config Release
```

Expected: compile failure, `cannot open source file "../src/buffer/smart_render.h"`.

- [ ] **Step 3: Write the planner**

Create `src/buffer/smart_render.h`:

```cpp
#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

namespace flash {

struct SmartRenderPlan {
    bool needsHeadEncode = false;
    int64_t headStartUs = 0;
    int64_t headEndUs = 0;
    int64_t copyStartUs = 0;
};

// keyframesUs must be sorted ascending. The returned plan re-encodes
// [headStartUs, headEndUs) and copies samples from copyStartUs onward.
inline SmartRenderPlan PlanSmartRender(const std::vector<int64_t>& keyframesUs,
                                       int64_t startUs, int64_t endUs) {
    SmartRenderPlan plan;
    if (endUs <= startUs) {
        plan.headStartUs = plan.headEndUs = plan.copyStartUs = startUs;
        return plan;
    }
    const bool onKeyframe = std::binary_search(keyframesUs.begin(), keyframesUs.end(), startUs);
    if (onKeyframe) {
        plan.copyStartUs = startUs;
        return plan;
    }
    const auto next = std::upper_bound(keyframesUs.begin(), keyframesUs.end(), startUs);
    const int64_t boundary = next == keyframesUs.end() ? endUs : (std::min)(*next, endUs);
    plan.needsHeadEncode = true;
    plan.headStartUs = startUs;
    plan.headEndUs = boundary;
    plan.copyStartUs = boundary;
    return plan;
}

} // namespace flash
```

- [ ] **Step 4: Register the test target**

In `CMakeLists.txt`:

```cmake
add_executable(flash_smart_render_test EXCLUDE_FROM_ALL test/smart_render_test.cpp)
if(MSVC)
  target_compile_options(flash_smart_render_test PRIVATE /EHsc)
  target_compile_definitions(flash_smart_render_test PRIVATE NOMINMAX)
endif()
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cmake --build build --target flash_smart_render_test --config Release
```

Then run `build/Release/flash_smart_render_test.exe` and confirm exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/flash-capture/src/buffer/smart_render.h packages/flash-capture/test/smart_render_test.cpp packages/flash-capture/CMakeLists.txt
git commit -m "feat(capture): plan frame-exact trims around keyframe boundaries"
```

---

## Task 3: Execute the frame-exact trim

Turn the plan into an actual file: re-encode the head fragment, then copy the remainder untouched.

**Files:**
- Create: `packages/flash-capture/src/buffer/smart_render.cpp`
- Modify: `packages/flash-capture/src/buffer/clip_trimmer.cpp:178-186`
- Modify: `packages/flash-capture/CMakeLists.txt`

**Interfaces:**
- Consumes: `PlanSmartRender` and `SmartRenderPlan` from Task 2.
- Produces: `bool flash::RenderHeadFragment(IMFSourceReader* reader, IMFSinkWriter* writer, DWORD videoStream, DWORD writerStream, const SmartRenderPlan& plan, IMFMediaType* sourceType)`

- [ ] **Step 1: Collect the keyframe list in the trimmer**

Before the copy loop in `clip_trimmer.cpp`, walk the video stream once and record the timestamp of every sample whose `MFSampleExtension_CleanPoint` attribute is true, then seek back to the start. Pass that vector to `PlanSmartRender`.

- [ ] **Step 2: Replace the hard failure**

`clip_trimmer.cpp:181` currently throws `"source reader did not seek to an H.264 keyframe"`. Replace that branch: when the plan reports `needsHeadEncode`, call `RenderHeadFragment`, then begin the copy loop at `plan.copyStartUs` instead of at the keyframe.

Keep the throw as the fallback when `RenderHeadFragment` returns false, so a smart-render failure degrades to today's behaviour rather than writing a corrupt file.

- [ ] **Step 3: Implement the head fragment encoder**

Create `src/buffer/smart_render.cpp`.

- Configure a decoder on the video stream by requesting `MFVideoFormat_NV12` from the source reader, which instantiates the H.264 decoder for you. Note this is the opposite of the trimmer's normal setup, which sets `MF_READWRITE_DISABLE_CONVERTERS` to force a pure remux — the head fragment is the one span that must actually decode.
- Build an encoder from `sourceType` so resolution, frame rate and profile match the copied body exactly. Do not invent settings; read them off the source media type.
- Tag every media type with `TagBt709Limited` from `src/color_space.h`. A head fragment encoded without colour tags would decode differently from the body, producing a visible shift at the splice.
- Force the first encoded frame to be an IDR.
- Rebase timestamps so the head starts at zero, matching what `RebaseTrimTimestamp` does for the copied samples.

- [ ] **Step 4: Verify the splice by hand**

Build the addon, trim a real clip with an in-point that is deliberately not on a keyframe, and check three things:

1. The output plays from the first frame in both VLC and Chrome.
2. The first second shows no colour or brightness shift where the head meets the body.
3. The reported start time matches what was asked for, within one frame.

Record the result in the commit message. There is no unit test for this step; the planner is tested, the muxing is not.

- [ ] **Step 5: Confirm the existing tests still pass**

Build and run every test target: `flash_ring_buffer_test`, `flash_quality_test`, `flash_audio_track_test`, `flash_clip_trimmer_test`, `flash_export_budget_test`, `flash_color_space_test`, `flash_audio_decode_test`, `flash_smart_render_test`. All must exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/flash-capture/src/buffer/smart_render.cpp packages/flash-capture/src/buffer/clip_trimmer.cpp packages/flash-capture/CMakeLists.txt
git commit -m "feat(capture): frame-exact trim via smart render of the head fragment"
```

---

## Task 4: Apply gain and saturation on save

Muting a track and changing saturation both mean the save can no longer be a pure copy. The exporter already decodes, mixes and re-encodes, so both features belong there rather than in a new path.

Saturation is applied in YUV, not RGB. The exporter already works in NV12, and saturation in NV12 is scaling each chroma sample's distance from 128 — no colour-space round trip, and exact.

**Files:**
- Modify: `packages/flash-capture/src/buffer/export_budget.h`
- Modify: `packages/flash-capture/src/buffer/clip_exporter.cpp:215`
- Modify: `packages/flash-capture/src/binding.cpp`
- Test: `packages/flash-capture/test/export_budget_test.cpp`

**Interfaces:**
- Produces:
  - `uint8_t flash::ApplySaturation(uint8_t chroma, uint32_t percent)`
  - `ExportOptions` gains a `std::array<float, 3> gains{1.0f, 1.0f, 1.0f}` field and a `uint32_t saturation = 100` field.

- [ ] **Step 1: Write the failing test**

Append to `test/export_budget_test.cpp`:

```cpp
    // 100 percent is identity, and must be bit-exact or every unmodified
    // clip would drift on save.
    assert(flash::ApplySaturation(128, 100) == 128);
    assert(flash::ApplySaturation(200, 100) == 200);
    assert(flash::ApplySaturation(16, 100) == 16);

    // Zero collapses chroma to neutral grey.
    assert(flash::ApplySaturation(200, 0) == 128);
    assert(flash::ApplySaturation(16, 0) == 128);

    // Half moves the sample halfway to neutral.
    assert(flash::ApplySaturation(228, 50) == 178);

    // Boosting clamps into range instead of wrapping.
    assert(flash::ApplySaturation(250, 200) == 255);
    assert(flash::ApplySaturation(10, 200) == 0);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cmake --build build --target flash_export_budget_test --config Release
```

Expected: compile failure, `ApplySaturation: identifier not found`.

- [ ] **Step 3: Implement saturation and extend the options**

In `export_budget.h`:

```cpp
// Saturation in YUV is the chroma sample's distance from neutral. No RGB
// round trip, and 100 percent is exactly the identity.
inline uint8_t ApplySaturation(uint8_t chroma, uint32_t percent) {
    if (percent == 100) return chroma;
    const int scaled = 128 + ((static_cast<int>(chroma) - 128) * static_cast<int>(percent) + 50) / 100;
    return static_cast<uint8_t>(std::clamp(scaled, 0, 255));
}
```

Add `#include <algorithm>` and `#include <array>` if they are not already present, and add the two new fields to the options struct with the defaults given in the Interfaces block above.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cmake --build build --target flash_export_budget_test --config Release
```

Then run `build/Release/flash_export_budget_test.exe` and confirm exit code 0.

- [ ] **Step 5: Apply gain in the mixdown**

`clip_exporter.cpp:215` currently reads:

```cpp
mix[(at + f) * kMixChannels + c] += source[f * kMixChannels + c];
```

Scale by the gain for the track being read. The loop iterates `audioStreams` in order, so the gain index is the stream's position in that vector, which matches `kAudioTrackOrder`. A gain of zero must produce exact silence for that track, not a very quiet copy.

- [ ] **Step 6: Apply saturation to the chroma plane**

Where the exporter writes each decoded NV12 frame, run every byte of the UV plane through `ApplySaturation` before the frame reaches the encoder. Skip the pass entirely when `saturation == 100` so unmodified saves stay on the fast path.

- [ ] **Step 7: Expose both through the binding**

In `binding.cpp`, read `gains` (an array of three numbers) and `saturation` (a number) from the export options object. Missing fields take the defaults — unity gain and 100 — so existing callers keep working unchanged.

- [ ] **Step 8: Verify by hand**

Export one clip with `other` muted and confirm Discord audio is gone while game and mic remain. Export another at saturation 0 and confirm it is greyscale, and at 200 and confirm it is vivid but not banded.

- [ ] **Step 9: Run every test**

All eight test targets must exit 0.

- [ ] **Step 10: Commit**

```bash
git add packages/flash-capture/src/buffer/export_budget.h packages/flash-capture/src/buffer/clip_exporter.cpp packages/flash-capture/src/binding.cpp packages/flash-capture/test/export_budget_test.cpp
git commit -m "feat(capture): per-track gain and saturation on export"
```

---

## Definition of done

- Eight test executables build and exit 0.
- `flash_capture.node` links with no new `/W4` warnings.
- A trim with an off-keyframe in-point starts on the requested frame and shows no visible seam.
- A clip exported with `other` muted has no Discord audio.
- A clip exported at saturation 100 is byte-identical in colour to one exported before this change.
