# Linux: phase L1

L1 adds the portable boundary and a Linux backend for CI compilation. **All Linux native code, the media build recipe, desktop integration, and Linux packages are untested on Linux.** This work was done on Windows without WSL or Docker. A green Windows run is not evidence that a Linux capture session works. CI must run after the reviewer commits and pushes.

## Current state

| Area | L1 implementation | Validation still required |
| --- | --- | --- |
| Native boundary | `src/core` interfaces, frames, packet PTS/DTS/duration, replay buffer, clocks, audio math and export planning; compile-time platform factories | Linux compiler and linker |
| Windows | Existing WGC/DXGI, MF, WASAPI and speech implementations under `src/platform/windows` | Existing native checks and hardware probes run on Windows |
| Wayland video | GDBus ScreenCast session, permission request, restore-token rotation, portal fd, mapped BGRx/RGBx PipeWire frames | GNOME, KDE, wlroots and Hyprland; cancel, revoke, suspend, unplug and source resize |
| Video encoding | Capture: probe `h264_vaapi`, then `h264_nvenc`, then `libopenh264`; closed GOP, no B-frames, two-second GOP. Share copies: `av1_vaapi`, then `av1_nvenc`, then the H.264 order, with High profile, a four-second GOP and a bitrate peak on the hardware encoders | Driver compatibility, inline SPS/PPS at every IDR, latency, colour, long recordings; AV1 in MP4 playback; size window accuracy per encoder |
| Audio | Default sink monitor and default microphone, 48 kHz stereo float; desktop audio uses the `other` lane | Timing, default-device changes, PipeWire routing and permissions |
| Saved media | MP4 H.264 plus native AAC tracks, audio preview decode, keyframe stream-copy trim, video re-encode export, PNG screenshot | Decode/playback, seeking, audio alignment, export budgets and encoder drain |
| Desktop adapters | POSIX clip URLs, platform-aware containment, XDG autostart, `/proc` fallback, Steam/Proton IDs, CLI commands | Real packaged Electron sessions |
| Packaging | AppImage and deb configuration; private LGPL-only shared libav libraries | Both package formats on real systems |

The portal picker chooses the screen or window. The current display list exposes one portal source with a 1920×1080 initial encode ceiling; source frames are converted to the configured output size. Accurate monitor geometry, aspect-ratio changes and multi-monitor selection need L2 work. Audio timestamps currently use the common monotonic clock corrected for block length; graph/device latency has not been measured. Linux media jobs currently buffer decoded audio and encoded export packets in memory, so long clips need memory profiling before release.

Smart render is **unsupported on Linux**, reported in the addon's `capabilities`. Linux trim cuts at the preceding keyframe and reports `actualStartSeconds`; precise edits must use export/re-encode. Voice activation reports unavailable. Per-app audio and X11 capture are not implemented. The overlay is off by default when `XDG_SESSION_TYPE=wayland`; users can opt in, but compositor behaviour is unverified.

## Dependencies and licence boundary

No x264, GPL-enabled FFmpeg, or nonfree-enabled FFmpeg is selected or bundled. `scripts/build-linux-media.sh` builds shared FFmpeg 7.1.2 with an explicit codec list, `--disable-gpl`, `--disable-nonfree`, and `--disable-autodetect`. It enables VA-API, NVENC through the MIT-licensed nv-codec headers, OpenH264, native AAC, H.264/AAC decoding, MP4 and PNG. There are no new npm dependencies. Flash's own licence remains undecided.

The runtime checks the libav configuration strings and refuses GPL/nonfree-enabled builds. Installing a distro's FFmpeg development headers is sufficient for compile-only checks, but **not sufficient for a usable or redistributable Flash media build**. Use the private prefix below for linking and packaging. Do not substitute an arbitrary `ffmpeg` executable or a distro's GPL-enabled libav libraries. The configured encoders and LGPL/GPL distinction are documented by [FFmpeg](https://ffmpeg.org/legal.html).

Build package names by distro family (versions and repository availability vary):

| Family | Compiler and native dependencies | Optional system libav development packages for compile-only checks |
| --- | --- | --- |
| Debian / Ubuntu | `build-essential cmake pkg-config git nasm patchelf zlib1g-dev libpipewire-0.3-dev libglib2.0-dev libva-dev libopenh264-dev` | `libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libswresample-dev` |
| Fedora | `gcc-c++ make cmake pkgconf-pkg-config git nasm patchelf zlib-devel pipewire-devel glib2-devel libva-devel openh264-devel` | `ffmpeg-free-devel` (the word “free” is not an LGPL-only build guarantee) |
| Arch | `base-devel cmake pkgconf git nasm patchelf zlib pipewire glib2 libva openh264` | `ffmpeg` includes development files; do not bundle its libav libraries |

OpenH264 may require the distro's Cisco OpenH264 repository. If no packaged development files are available, build upstream OpenH264 separately and put its `.pc` file on `PKG_CONFIG_PATH`; do not replace it with x264. Fedora's libav subpackages are listed in the [Fedora package catalog](https://packages.fedoraproject.org/pkgs/ffmpeg/). The PipeWire package and its splits are listed in the [Arch package catalog](https://archlinux.org/packages/extra/x86_64/pipewire/).

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

Runtime also needs a working user session bus, PipeWire with an audio session manager such as WirePlumber, GLib/GIO, libva/libva-drm, the GPU's appropriate driver, and the desktop portal plus a backend. AppImage may need FUSE 2 (`libfuse2` on Ubuntu 24.04); extracting the AppImage is an alternative where FUSE is unavailable.

## Portal backends and shortcuts

Install `xdg-desktop-portal` and the backend for the actual desktop:

| Desktop | ScreenCast backend |
| --- | --- |
| GNOME | `xdg-desktop-portal-gnome` |
| KDE Plasma | `xdg-desktop-portal-kde` |
| wlroots / Sway | `xdg-desktop-portal-wlr` |
| Hyprland | `xdg-desktop-portal-hyprland` |

wlroots/Hyprland sessions commonly also use `xdg-desktop-portal-gtk` for interfaces such as file selection. GTK alone does not supply this capture backend. Portal selection follows the session's `XDG_CURRENT_DESKTOP` and `portals.conf`; use the desktop's configuration instead of indiscriminately starting every backend. See the [portal backend documentation](https://flatpak.github.io/xdg-desktop-portal/docs/) and [portal configuration](https://flatpak.github.io/xdg-desktop-portal/docs/portals.conf.html).

The ScreenCast flow is CreateSession → SelectSources (`persist_mode=2`, optional restore token) → Start → OpenPipeWireRemote. Requests subscribe before the call so fast replies are not lost. Start returns a replacement token; the native callback sends it to the main process, which persists it in settings. Tokens restore permission, never footage. Cancellation/denial stops recording and waits for an explicit retry instead of repeatedly reopening the picker. See the [ScreenCast specification](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html).

Electron uses the GlobalShortcuts portal on Wayland. Both `desktopName` and `app.setDesktopName()` use `flash.desktop`; packaging uses the same desktop entry with `StartupWMClass=flash`. The existing hotkey status reports false/throwing registrations. Portal support and consent vary by desktop, and Electron may not expose every asynchronous backend rejection; verify shortcuts in L2. In particular, newer GNOME versions may require a reverse-DNS application identity, so `flash.desktop` compatibility must be checked there. See [Electron's Linux shortcut notes](https://www.electronjs.org/docs/latest/api/global-shortcut/).

Compositor bindings can invoke an installed executable or the full AppImage path:

```sh
flash --save-clip
flash --save-short
flash --screenshot
```

A second launch forwards to the primary instance and does not raise its window. Commands arriving during startup are queued until initialization completes. A first launch can start Flash, but cannot save footage from before capture began.

## Paths and autostart

Clips use `app.getPath('videos')/Flash`. Settings and portal tokens use `app.getPath('userData')/settings.json`, and Chromium's session storage retains Electron's user-data location. No Linux settings path is hard-coded to a Windows directory. Electron resolves the platform/XDG locations. Autostart uses `$XDG_CONFIG_HOME/autostart/flash.desktop` when the variable is absolute, otherwise `~/.config/autostart/flash.desktop`. AppImage autostart records the stable `APPIMAGE` path rather than a temporary mounted executable. Moving the AppImage requires toggling autostart again.

`/proc` reads tolerate disappearing and inaccessible processes. Native enumeration is preferred, with a TypeScript fallback. Wine, wineserver, Proton, Steam and steamwebhelper are infrastructure; a Wine invocation carrying a game `.exe` is treated as that executable. Readable `SteamAppId`, `STEAM_COMPAT_APP_ID` or `compatdata/<appid>` identify otherwise unknown Steam games. Wayland has no generic foreground-window PID, so detection cannot promise to select the focused game when several are running. `/proc` restrictions and Flatpak will need separate handling in L2.

## Build on Linux

Use Node 24 and pnpm 11.20.0. On Debian/Ubuntu, install the dependencies above, then from the repository root:

```sh
bash scripts/build-linux-media.sh
export PKG_CONFIG_PATH="$PWD/build/linux-media/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$PWD/build/linux-media/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
pnpm install --frozen-lockfile
pnpm --filter @flash/capture run build
cmake --build packages/flash-capture/build --target flash_tests
ctest --test-dir packages/flash-capture/build --output-on-failure
pnpm typecheck
pnpm test
pnpm build
```

The media script downloads pinned release tags into ignored `build/`, records its configuration and dependency notices, and installs private shared libraries. Set `OPENH264_LICENSE` to the installed OpenH264 licence/notice file if the script cannot find the distro's copy. Do not run this Linux recipe in Windows PowerShell.

Packaging on Linux only:

```sh
patchelf --set-rpath '$ORIGIN/linux-media' packages/flash-capture/build/flash_capture.node
pnpm --filter @flash/desktop exec electron-builder --linux AppImage --publish never
# Supply real maintainer information before distributing a deb.
pnpm --filter @flash/desktop exec electron-builder --linux deb --publish never
```

The Ubuntu 24.04 CI job builds the addon, portable native checks and renderer, then uploads an AppImage artifact. Actions and tool versions are pinned. The Windows job builds the addon and runs typechecking and all existing native self-checks. Neither job is a Linux desktop/GPU test. Ubuntu 24.04 artifacts are not a promise of compatibility with older glibc systems; establishing a lower build baseline and a distro matrix is required before claiming “most distros”.

The existing Windows screenshot self-check requires an accessible desktop. A hosted runner without one can fail that check; CI intentionally does not silently skip it or claim hardware validation.

## Windows L1 verification (2026-10-09)

`pnpm typecheck`, `npx cmake-js build` in `packages/flash-capture`, and `pnpm test` passed. The suite rebuilt and passed 12 TypeScript and 11 native self-checks. The electron-builder configuration passed its installed version's schema validator without building a Linux package. The preload probe passed all eight subscription checks.

Representative output from the required hardware probes:

```text
record-and-save: saved: 20.00s  7.8 MB
audio tracks: game(20.0s) mic(20.0s) other(20.0s)
after save: recording=true healthy=true error=none
trim-on-keyframes: all 14 requested trims reported drift 0.0000s
audio-lands-in-place: PASS: the loudest window is 0 of 6, in the first half where the sound was
reapply-settings: buffered before re-apply: 6.0s, after 3 re-applies + 3 s: 9.0s
export-and-game: PASS: two exports coexist (1226685 and 1226685 bytes, budget 10485760)
PASS: failed exports preserve earlier copy and leave no partial or published file
PASS: measured oversize retries once, reports the budget error and removes the partial
PASS: repeated trims coexist and native trim refuses existing destinations
```

This Windows sandbox denied Node's child-process pipes (`spawn EPERM`). Verification used `scripts/windows-sandbox-spawn.cjs`, an opt-in preload that runs the real child processes with temporary output files; it does not mock tests or production code. In PowerShell, set `NODE_OPTIONS` to `--require "<absolute path using forward slashes>/scripts/windows-sandbox-spawn.cjs"` for this workaround. CI does not use the shim. No Electron processes were killed.

The sandbox also denied `git mv` because `.git` is read-only. Files were moved in the worktree; the reviewer must stage deletions and additions together for Git's rename detection. Nothing was committed, and the pre-existing `.impeccable/hook.cache.json` change was left alone.

## Next phases

- **L1 (this change):** platform boundaries, Linux skeleton, Windows regression verification, portable tests, packaging configuration and CI.
- **L2:** compile and run on real AMD/Intel/NVIDIA hardware across GNOME/KDE/wlroots/Hyprland; verify saved clips and all lifecycle failures; measure sync, dropped frames, CPU and memory; implement DMA-BUF import with modifiers/fences, X11/XShm fallback, per-app audio, and Flatpak permissions/manual game selection. Run a share-copy export per distro family and GPU vendor: confirm the codec chosen, that the file plays in Flash and in Discord, and that it lands between 88% and 100% of the limit; then decide whether B-frames can be enabled for exports. Confirm Steam Deck scope and the oldest supported distro/glibc baseline.
- **After hardware validation:** broaden the distro matrix, dependency/security updates and licence/notice distribution review, installer polish, then a release candidate. No Linux support claim or release is made by this L1 change.
