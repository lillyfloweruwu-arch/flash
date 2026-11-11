# Pre-release audit, 2026-11-11 (branch audio-lanes)

Six read-only audits (AUDIO, VIDEO, LINUX, MAIN, UI, SHIP). Findings are from reading code, not from running it.
"Checked" means the lead re-read the cited line and it matches. Everything else is unchecked.

## Tier 1: fix before any beta

| ID | Where | Problem | Checked |
|----|-------|---------|---------|
| AUDIO-1 | audio_capture.cpp:567 | WASAPI packets timestamped at drain time, so overlap and silent filler. This is the crackle / out-of-sync complaint | no |
| AUDIO-2 | audio_capture.cpp:549 | Unplugging a mic or changing the default device leaves a silent track | no |
| AUDIO-3 | lane_mixer.h:56 | 30 ms hold is too short, so a ~20 ms stall leaves silent gaps | no |
| VIDEO-1 | encoder_factory.cpp:45 | Hardware encoder dies mid-session and is rebuilt as hardware again, with no software fallback (AMD / Intel) | no |
| VIDEO-3 | mf_hardware_encoder.cpp:166 | Four input textures are reused without tracking release, giving torn frames or a hang | no |
| VIDEO-6 | clip_exporter.cpp:548 | AV1/HEVC failure is swallowed (`catch ... continue`), so it silently falls to H.264. Likely related to the blurry copy | yes |
| VIDEO-2 | wgc_source.cpp:215 | Capture can die silently after a resolution change | no |
| UI-1, UI-2, UI-7 | Editor.tsx:96, FeedView.tsx:182, ui.tsx:263 | Save / export / delete errors are swallowed and buttons stay stuck | no |
| MAIN-2 | main.ts:1879 | Unguarded addon init can leave the app running with no window | no |
| MAIN-1 | main.ts:188 | Unplugged clips drive makes Flash persist the default folder, which looks like lost clips | no |
| MAIN-4 | main.ts:1015 | A transient monitor loss permanently replaces the chosen display | no |

## Tier 2: fix soon

VIDEO-4 (hybrid GPU MFT), VIDEO-5 (ring buffer has no byte cap), UI-3 to UI-6, MAIN-5, MAIN-6, MAIN-10, AUDIO-8, AUDIO-4 to AUDIO-7.

MAIN-3 (auto-delete can remove personal files in a general folder): `autoDeleteDays` defaults to 0, so this only happens if the user turns auto-delete on and picks a general folder. Warn on that combination.

## Tier 3: Linux (not shippable as it stands)

- LINUX-1 (hard-link publish fails on exFAT/NTFS/SMB; line 70 checked): small fix, fall back to rename.
- LINUX-10 (`streams[-1]` on a file with no video): small fix.
- LINUX-13 (GVariantBuilder returned by value): small fix. Severity unclear; it may work in practice.
- LINUX-2, 3, 4 (pixel format and DMA-BUF, hardcoded 1920x1080, no restart after portal loss) need a Linux machine and real capture work.
- LINUX-5 to 9, 11, 12, 14 and the sandbox / glibc issues also need real hardware.

## Ship / packaging (SHIP-*)

Unsigned installer. `perMachine: true` forces admin. The `package` script does not rebuild the addon. No LICENSE or notices. CI never builds a Windows installer.
Version should read 0.1.0-beta.1. Install size 100 MB goal is not reachable on Electron; vulkan files in after-pack are a small win.
Open question for the owner: bundling distro libopenh264 in the AppImage (patent cover).

## Not bugs

SHIP-14: StdUtils is included by electron-builder.
