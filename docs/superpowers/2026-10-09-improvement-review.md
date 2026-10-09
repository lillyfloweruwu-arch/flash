# Flash improvement review — 2026-10-09

Three reviewers looked at Flash independently. Each was told it could ask the owner questions.

- **Codex** (`codex exec`, read-only, full repo access). It wrote the deepest audit, with file:line evidence. All 11 TypeScript self-checks and the typecheck passed. It did not build or run the native addon.
- **FlashBot** (local `flashbot:latest`, 9B, prompt only, no repo access). It produced a generic idea list. Several Linux points are wrong, and they are flagged below.
- **Claude** orchestrated, cross-checked both, and added its own findings. This session also delivered the UI redesign; see the end of this file.

## Fix first: correctness and data loss (all from Codex, checked against the code)

| # | Problem | Effort | Where |
|---|---|---|---|
| 1 | **Idle polling resets the replay buffer.** When no game is running, `game?.name !== currentGame` compares `undefined` with `null`. That makes every 3 s poll call `applyCaptureSettings()`, which clears the buffer and rebuilds capture. Normalise the value, and make the native setters do nothing when the value has not changed. | S | `main.ts:885`, `binding.cpp:401`, `ring_buffer.cpp:82` |
| 2 | **`round.mp4` and `round.png` share `round.json`.** Starring or deleting one changes the other's protection from auto-delete. Fix: per-file sidecars plus a migration. | S–M | `main.ts:459/511/635`, `clipPath.ts` |
| 3 | **Re-exporting at the same size overwrites the previous share copy.** If that export then fails, the earlier good file is already gone. Fix: write to a unique temp name and rename it into place. | S | `main.ts:1334`, `clip_exporter.cpp:239` |
| 4 | **Settings are only type-checked.** No ranges or enums are enforced, and `capture-set-buffer-length` skips validation entirely. Fix: one shared schema. | S–M | `sanitise.ts`, `main.ts:1181/1391` |
| 5 | **A game exiting leaves its identity and audio target set in native code.** Sidecars get the game name that is current at mux time, not the one at save time. | S | `main.ts:879`, `binding.cpp:298` |
| 6 | **The export size limit is never checked after encoding.** Very small budgets are impossible to meet but are still attempted. | S–M | `clip_exporter.cpp:364` |
| 7 | **An audio-only edit re-encodes the video at a 200 Mbps ceiling.** Fix: copy the video stream when only audio changes. | M | `Editor.tsx:99`, `export_budget.h` |
| 8 | **Electron 33 is end-of-life.** Upgrading also brings Wayland global shortcuts through the portal. | M | `package.json` |

## Reliability and performance (Codex + Claude)

- **Recording state.** Use one recording state machine. The watchdog should watch the time of the last encoded packet, not only the reported health.
- **Audio devices.** Follow default-device changes, so switching headsets cannot silently drop a track.
- **Ring buffer memory.** Bound it by bytes as well as seconds, and stop deep-copying the whole history under the mutex on every save. Three PCM tracks alone take about 35 MB per 30 s and about 690 MB at 10 min.
- **Known native defects** from `flash-open-defects`:
  - texture reuse: use a tracked pool rather than allocating a texture per frame;
  - drain-time audio timestamps: switch to QPC timestamps;
  - `process.exit` segfault: a release blocker.
- **Library performance.** Use one cached library scan plus a thumbnail cache instead of one video decoder per tile. Virtualise the grid for large libraries.
- **Media jobs.** Add a job queue with cancellation, and publish files atomically so half-written MP4s never look like clips.
- **Playback audio.** The player plays a 22.05 kHz mono decode of the clip's audio. Play stereo, and keep the reduced decode for waveforms only.
- **Deleting.** Move deleted clips to the Recycle Bin, or give a short undo, instead of deleting permanently.
- **Tests and CI.** There is no git remote and no CI. `pnpm test` passes even when it skips the native checks.

## Features worth adding (lean filter applied)

**Worth adding:**
- **Post-roll**, so a clip also keeps a few seconds after the hotkey.
- **A bookmark hotkey.**
- **A quick audio/setup test.**
- **Export presets** that remember the last choice.
- **"Never detect this app"** and a manual recording target.
- **Merging clips without re-encoding** (FlashBot's idea, and a sound one).
- **A user-initiated "Check for updates"** with signed releases and no telemetry.

**Rejected** because they break the local, lean, no-account promise:
- FlashBot's cloud sync;
- watermarked social sharing;
- ML highlight detection;
- object/face search.

## Linux plan (Codex's design, endorsed)

FlashBot suggested `libcamera`, `xvfb` and ALSA-as-WASAPI. **Those are wrong for screen capture and were discarded.**

- **Architecture.** Split `flash-capture` into `core/` (replay store, clocks, jobs), `media/` (libav mux/decode/export) and `platform/{windows,linux}/`. Windows keeps WGC/WASAPI/MFT. Grow `EncodedPacket` to carry PTS/DTS/duration.
- **Capture.**
  - Wayland: the xdg-desktop-portal ScreenCast portal plus PipeWire, with restore tokens. A token restores the permission, not lost footage.
  - X11 fallback: XShm.
  - KMS/DRM: later only, and only as a separate privileged helper.
- **Encoding.** Use a minimal FFmpeg/libav build with VA-API (AMD/Intel), NVENC (NVIDIA) and a software fallback. x264 is GPL, so settle Flash's licence first.
- **Zero-copy.** PipeWire DMA-BUF into an encoder-owned NV12 surface. Ship a CPU-copy path first.
- **Audio.**
  - Alpha: a PipeWire sink monitor plus the mic.
  - Per-app game audio: phase 2.
- **Hotkeys.** After the Electron upgrade, use Electron's GlobalShortcuts portal support. The fallback is a compositor binding that runs `flash --save-clip`. Do not use evdev.
- **Game detection.** Read `/proc`. Identify Steam/Proton games by app ID and `compatdata`, and treat Wine processes as infrastructure. Flatpak starts with a manually chosen game.
- **Desktop integration.**
  - Tray: StatusNotifierItem.
  - Autostart: a `.desktop` file under `~/.config/autostart`, or the Background portal in Flatpak.
  - Directories: follow XDG.
  - Clipboard: Linux file URIs.
  - Overlay: optional.
- **Packaging.** AppImage for the alpha, then Flatpak, then .deb/.rpm and the AUR.
- **Phases.** Stabilise (2–3 wk), then a Linux vertical slice (3–5 wk), then a hardware beta (4–7 wk), then broad desktop coverage (4–6 wk), then hardening (2–4 wk). That puts a first alpha about 5–8 engineering weeks out, and broad distro support about 15–25.

## Open questions for the owner (merged from all three)

1. Licence: proprietary, permissive open source, or GPL? This decides whether x264 can ship.
2. What does "lean" mean first: installed size, idle RAM, recording RAM, or in-game FPS cost?
3. Which Linux machines and desktops can be tested (GPU, distro, GNOME/KDE/Hyprland)? Is the Steam Deck in scope?
4. Is a one-time screen-share permission prompt on Linux acceptable, with an occasional re-prompt?
5. Is adding a minimal FFmpeg/libav dependency acceptable (tens of MB, to be measured)?
6. Must the first Linux version separate game audio from other apps, or is desktop audio plus mic enough?
7. Is a separate native helper process acceptable, so a capture crash cannot take down the UI?
8. Are user-initiated update checks acceptable under the local-only promise?
9. Order of work: reliability fixes first, then Linux (recommended), or Linux right away?
10. Should Flash get a GitHub remote so CI can build Windows and Linux?

## UI redesign delivered in this session

- **Direction.** Full redesign in the "full-bleed feed" direction, chosen by the owner:
  - one clip fills the window and the next is one flick away;
  - white outlined glyphs, a bottom scrim, and Antonio display type;
  - the theme accent appears only on live or engaged state.
- **Screens.** Feed (new home), Library (edge-to-edge tiles that preview on hover), and Settings (an index plus sections). The editor and dialogs were restyled to match.
- **Themes.** The six themes are retuned to near-black neutrals.
- **Code.** `App.tsx` went from about 1,840 lines to about 540. The views are split into `FeedView`, `LibraryView`, `SettingsView` and `ui.tsx`.
