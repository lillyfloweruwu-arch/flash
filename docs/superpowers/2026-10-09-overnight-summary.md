# Overnight summary — 2026-10-09

Branch `ui-redesign`: 11 commits on top of `clip-editor-native-foundation`. Nothing is
pushed, because there is no remote, and nothing is merged into `master`.

**Ready to install:** `release\Flash Setup 0.1.0.exe` (97.5 MB, signed). It needs the
UAC prompt, so it was not installed. The packaged build was run unpacked from
`release\win-unpacked` and checked:

- Electron 44.7.0;
- 68 clips;
- NVENC recording;
- the Watch clip playing;
- a save and a delete.

## What changed

| Commit | What |
|---|---|
| `20278bf` | **UI redesign.** Watch (the new home: one clip full-window, flick to the next), Library (tiles grouped by day, hover plays), Settings (section index, theme swatches over a real clip). Editor and dialogs restyled to match. The Antonio font is bundled. |
| `5913721` | DESIGN.md and PRODUCT.md, which record the new design system. |
| `5be514c` | **The replay reset every 3 seconds whenever no game was running.** Fixed in both the JS and the native code. |
| `70b73c5` | Each clip and screenshot gets its own metadata file (66 existing ones migrated, no stars lost). Exports never overwrite older exports. Settings are validated. The game name is cleared when a game exits. Export size is enforced. |
| `5f7e451` | Electron 33 (out of support) to 44. Copy and screenshot clipboard ported to the new API. A delete right after saving now retries instead of silently failing. |
| `497a03c` | **Linux groundwork.** The native code is split into a shared core plus per-OS layers. Added a Linux backend (PipeWire screen capture through the desktop portal, FFmpeg encoding with no GPL code, PipeWire audio, `/proc` game detection), AppImage/deb packaging, GitHub Actions CI, and `docs/linux.md`. **The Linux code has not been compiled or run yet.** |
| `34ca5dc` | Second pass after the reflection round:<br>• Enter on a focused Cancel no longer deletes.<br>• Starring a clip during an auto-delete retry protects it.<br>• Playback pauses when the window is hidden or minimized.<br>• Recordings and screenshots are written atomically.<br>• The in-game toast and overlay match the redesign.<br>• Dropdown menus can't overflow the window, and clip video seeking is fixed. |
| `11ee4a7`, `ae31b92` | The native addon no longer crashes on exit. A font-loading bug that made every save report an error in the dev build is fixed. |
| `33ed3fe` | Unused WebGPU DLLs dropped from the package (about 26 MB). |

`pnpm test` passes. That covers the TypeScript checks, the 11 native self-checks, and the
safe integration probes.

## Who did what

- **Codex** wrote most of the implementation from specs.
- **Claude** wrote the specs, reviewed and re-ran every check before each commit, and fixed what slipped through:
  - the dev-build font crash;
  - a probe left stale by that fix;
  - the Electron 44 clipboard API change;
  - the delete race when deleting right after a save;
  - the package size trim.
- **FlashBot** contributed ideas twice. Prompt-only review without repo access was weak, which the reflection notes.

## Things to know

- **Size:**
  - Electron 44 made Flash larger: 297 MB unpacked, versus 231 MB on Electron 33.
  - Most of the growth is in Electron's own `Flash.exe`.
  - This is the price of a supported, patched Chromium.
- **Linux is not tested yet:**
  - It needs either a Linux machine or WSL. WSL isn't installed here, and installing it needs an admin prompt.
  - Adding a GitHub remote would let the CI workflow compile it.
- **Your installed Flash** was closed overnight while the dev build ran. It has been restarted, and it is still the old 19 September build until you run the new installer.
- **Test clips:** a handful of test clips were saved into `Videos\Flash\Roblox` during verification, and all of them were deleted again.

## Still open

- **Owner questions** in `2026-10-09-improvement-review.md`: Linux test hardware, Steam Deck, a native helper process, and update checks.
- **Remaining reliability items** from the review:
  - a recording-state watchdog driven by encoder output;
  - following audio-device changes;
  - bounding ring-buffer memory by bytes;
  - the WASAPI timestamp model;
  - the encoder texture pool;
  - a thumbnail cache.
- **Linux phase L2:** run on real hardware, DMA-BUF zero-copy, X11 fallback, per-app audio, Flatpak.
