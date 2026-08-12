# Fullscreen capture — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record real frames when a game is running fullscreen, instead of a near-black picture.

**Architecture:** Add a Windows.Graphics.Capture backend alongside the existing DXGI Desktop Duplication one, behind the interface `ScreenCapture` already presents. WGC is preferred where available; duplication stays as the fallback so nothing regresses on older Windows or if WGC fails to start.

**Tech Stack:** C++20, WinRT (`windows.graphics.capture.h`, C++/WinRT headers ship with the 10.0.26100 SDK already selected by CMake), D3D11, Media Foundation.

## The evidence

From the user's own clip library, mean luma of a frame two seconds in:

    2026-08-09 00:52   meanY 171.5   windowed      good
    2026-08-09 01:55   meanY  95.6   windowed      good
    2026-08-09 21:26   meanY  36.4   fullscreen    black
    2026-08-11 14:35   meanY  30.0   fullscreen    black
    2026-08-11 22:13   meanY 163.6   windowed      good

Chroma on the dark ones sits at roughly 126/126 - neutral - so it is not a
colour-conversion artefact but a genuinely near-black picture with faint
content. This is the documented behaviour of Desktop Duplication against a
fullscreen-exclusive or otherwise protected swapchain.

## Global constraints

- **No new dependencies.** C++/WinRT headers come with the Windows SDK. Do not add cppwinrt from a package manager, and do not add a capture library.
- Windows-only code behind `#ifdef _WIN32`, matching every other file in this package.
- MSVC `/W4` clean with `NOMINMAX`; write `(std::min)(a, b)` with parentheses.
- The public shape of `ScreenCapture` in `src/capture/screen_capture.h` does not change. `binding.cpp`, the encoder and the ring buffer must not need edits.
- WGC needs an MTA or a DispatcherQueue. The capture thread already runs its own loop; create a `DispatcherQueueController` for it rather than assuming one exists.
- **Never remove the duplication path.** It is the fallback, and it is what works today for windowed capture.

## What exists now

`src/capture/screen_capture.cpp` owns the whole pipeline: `CreateDuplication` at
line 74 calls `DuplicateOutput`, `CaptureLoop` calls `AcquireNextFrame` at line
245, and `DeliverFrame` converts BGRA to NV12 through a D3D11 video processor
and hands a texture to the encoder.

The conversion and delivery half is backend-agnostic and must be reused, not
duplicated: whichever backend produces the frame, it ends up in the same
`VideoProcessorBlt` and the same `FrameCallback`.

---

## Task 1: Split the frame source from the frame delivery

Before adding a second backend, separate the part that gets a texture from the
part that converts and delivers it. No behaviour change.

**Files:**
- Create: `packages/flash-capture/src/capture/frame_source.h`
- Modify: `packages/flash-capture/src/capture/screen_capture.cpp`
- Modify: `packages/flash-capture/src/capture/screen_capture.h`

**Interfaces:**
- Produces:
  - `struct flash::SourceFrame { ID3D11Texture2D* texture; int64_t timestampUs; }`
  - `class flash::FrameSource` with `virtual bool Start(uint32_t displayId, uint32_t fps)`, `virtual bool Next(SourceFrame&, uint32_t timeoutMs)`, `virtual void Stop()`, `virtual const char* Name() const`

- [ ] **Step 1: Define the interface**

`frame_source.h` declares the abstract source. It must expose no WGC or DXGI
types in its signature - that is the entire point, and it is what lets the two
backends be swapped without touching the encoder path.

- [ ] **Step 2: Move duplication behind it**

Extract the existing `CreateDuplication` / `AcquireNextFrame` / release logic
into a `DuplicationSource` implementing `FrameSource`, in the same file for now.
`CaptureLoop` calls `source_->Next(...)` instead of `AcquireNextFrame`
directly. `DeliverFrame` is untouched.

Keep the existing device-lost handling: `RecreateDuplication` and its backoff
move into the source, and a failure still surfaces through `SetCaptureError`.

- [ ] **Step 3: Verify nothing changed**

Build the addon, record an 8-second clip through the addon directly, and probe
its mean luma. It must match what the same desktop produces today - a bright
desktop should give roughly 200, not 30. Confirm `getStatus()` still reports
`captureHealthy`.

- [ ] **Step 4: Commit**

```bash
git add packages/flash-capture/src/capture
git commit -m "refactor(capture): separate the frame source from frame delivery"
```

---

## Task 2: Add the Windows.Graphics.Capture source

**Files:**
- Create: `packages/flash-capture/src/capture/wgc_source.cpp`
- Modify: `packages/flash-capture/src/capture/frame_source.h`
- Modify: `packages/flash-capture/CMakeLists.txt`

**Interfaces:**
- Consumes: `FrameSource` from Task 1.
- Produces: `std::unique_ptr<flash::FrameSource> flash::CreateWgcSource()`, returning null when WGC is unavailable.

- [ ] **Step 1: Availability check**

`GraphicsCaptureSession::IsSupported()` gates everything. Return null rather
than throwing when it is false, so the caller falls back cleanly. Also check
`ApiInformation::IsPropertyPresent` for `IsBorderRequired` - on 10.0.19041 and
later the yellow capture border can be turned off, and on earlier builds it
cannot, which is a visible difference worth knowing about rather than
discovering later.

- [ ] **Step 2: Create the capture item for a monitor**

Get an `HMONITOR` for the requested `displayId` using the same enumeration
order `ScreenCapture::ListDisplays` already uses, so display ids keep meaning
the same thing. Turn it into a `GraphicsCaptureItem` via
`IGraphicsCaptureItemInterop::CreateForMonitor`.

- [ ] **Step 3: Frame pool and session**

Create a `Direct3D11CaptureFramePool` on the existing D3D11 device - the one
the encoder already shares - so frames need no cross-device copy. Use
`CreateFreeThreaded` so frames can be pulled from the capture thread without a
message pump.

Set `IsCursorCaptureEnabled` to match current behaviour, and
`IsBorderRequired = false` where the property exists.

- [ ] **Step 4: Implement Next()**

`TryGetNextFrame` returns null when no new frame is ready; that is normal and
must not be treated as an error. Convert the frame's `IDirect3DSurface` to an
`ID3D11Texture2D` through `IDirect3DDxgiInterfaceAccess::GetInterface`.

Frames must be closed before the next is pulled, or the pool starves.

- [ ] **Step 5: Register the source**

Add `wgc_source.cpp` to `CAPTURE_SOURCES`.

- [ ] **Step 6: Verify against the actual bug**

This is the whole point of the task, and it needs a fullscreen game running.
Record with a game in fullscreen-exclusive mode and probe the mean luma of a
frame two seconds in. It must be in the normal range - well over 100 on typical
gameplay - rather than the 30 that duplication produces.

Also confirm windowed capture still works, and that the frame rate holds at the
configured fps rather than dropping.

- [ ] **Step 7: Commit**

```bash
git add packages/flash-capture/src/capture/wgc_source.cpp packages/flash-capture/src/capture/frame_source.h packages/flash-capture/CMakeLists.txt
git commit -m "feat(capture): add a Windows.Graphics.Capture frame source"
```

---

## Task 3: Choose the backend, and say which one is running

**Files:**
- Modify: `packages/flash-capture/src/capture/screen_capture.cpp`
- Modify: `packages/flash-capture/src/binding.cpp`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Prefer WGC, fall back to duplication**

On `Initialize`, try `CreateWgcSource()` first. If it returns null or fails to
start, fall back to the duplication source and record why. Never fail
initialization outright because WGC was unavailable.

- [ ] **Step 2: Report it through getStatus**

`getStatus()` already carries `encoder` and `captureHealthy`. Add
`captureBackend`, reporting the source's `Name()`. Diagnosing "why is my clip
black" took a full evidence trail this session; the app should just say which
backend it is on.

- [ ] **Step 3: Surface it in Settings**

Show the backend next to the encoder in the Settings panel, where the encoder
name is already displayed. One line, no new panel.

- [ ] **Step 4: Verify the fallback**

Force `CreateWgcSource` to return null, confirm capture still works through
duplication and that Settings says so, then restore.

- [ ] **Step 5: Commit**

```bash
git add packages/flash-capture/src apps/desktop/src
git commit -m "feat(capture): prefer Windows.Graphics.Capture, and report the backend"
```

---

## Definition of done

- A clip recorded with a game in fullscreen-exclusive mode has a normal mean
  luma rather than a near-black one.
- Windowed capture is unchanged.
- Settings names the capture backend in use.
- Duplication still runs when WGC is unavailable, and initialization never
  fails because of WGC.
- The addon builds `/W4` clean and every existing self-check still passes.
