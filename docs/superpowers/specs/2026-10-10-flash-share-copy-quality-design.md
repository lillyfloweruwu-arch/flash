# Share copy quality (piece 1 of 3)

Date: 2026-10-10
Status: awaiting review

This is the first of three pieces agreed on 2026-10-10. The other two, audio lanes
(separate Discord and Music tracks, and the silent `game` track) and capture audio
timing (crackle and sync), get their own specs. Nothing here changes how clips are
recorded.

## Problem

"Export to size" produces a copy that looks much worse than it has to, and sometimes
lands well under the size it was allowed.

Measured on `Rocket League/2026-10-09_22-15-41.mp4` (1920x1080, about 141 fps variable,
14.3 s) exported at the 10MB limit on Windows:

- The copy is H.264 **Constrained Baseline** with no B-frames. `clip_exporter.cpp` hands
  the sink writer a target type with no profile, and the hardware encoder's default is
  Baseline. The same default shows up when ffmpeg drives the same Windows encoder.
- The copy is 1280x720 at **70 fps**. `PlanExport` only knows "full rate" and "half
  rate", so a 141 fps source becomes 70 fps, and the halving keeps "the first frame in
  each slot" of a variable-rate source, which gives uneven spacing.
- Sizes are inconsistent. This copy is 9.82 MB, but
  `2026-10-06_15-32-26 - edit - 10MB.mp4` is 7.43 MB. The plan reserves 5% and the retry
  only ever moves the bitrate down.

The audio in the copy is not the problem. Against the original three-track mix it
correlates at 0.97, with the same loudness and the same spectrum up to 24 kHz. What
sounds wrong is already in the recording, and belongs to pieces 2 and 3.

## Goal

A 10MB share copy of a 1080p clip that the user is happy to post in Discord, landing
close to the limit every time, on Windows and on Linux.

What was decided with the user:

- AV1 is the preferred codec. The user picked HEVC over two H.264 versions by eye
  (`Flash-compare/C - HEVC 1080p60.mp4`), then preferred AV1 once it was on the table
  (`Flash-compare/D - AV1 1080p60.mp4`), because it plays for every viewer.
- A copy between about 8.8 and 10 MB (as Explorer shows it) is fine for the 10MB limit.
  Smaller than that is wasted quality.
- No bundled ffmpeg on Windows. The install stays the size it is.
- Linux and all of its distros count equally with Windows.

Not promised: matching files C or D exactly. They were made with ffmpeg's NVENC
settings, and the Media Foundation path exposes fewer controls. The acceptance check is
the user comparing Flash's own output with D.

## Design

### Codec

`ExportOptions` gains `codec`, one of `Auto` or `H264`. `ExportResult` gains `codec`
(`"av1"`, `"hevc"` or `"h264"`), so the caller can tell what `Auto` chose.

`Auto` walks a ladder and takes the first codec that has a **hardware** encoder:

| Step | Windows | Linux |
|---|---|---|
| 1 | AV1 | AV1 |
| 2 | HEVC (Main, 8-bit) | skipped |
| 3 | H.264 High | H.264 High |

`H264` always uses H.264, requested as High profile with CABAC and B-frames.

Why hardware only for AV1 and HEVC: Windows has no built-in software encoder for
either (the software HEVC probe on the development machine fails), and on Linux the
software options are either GPL (x265) or far too slow for an interactive export.

Why Linux skips HEVC: Chromium on Linux decodes HEVC only through VA-API, which is often
unavailable, so an HEVC copy can be a black frame in Flash's own player and in Discord
on Linux. AV1 and H.264 do not have that problem.

GPUs that can encode AV1, for reference:

| Vendor | Oldest that works |
|---|---|
| NVIDIA | RTX 40 series (RTX 4050 laptop, RTX 4060 desktop) |
| AMD | RX 7000 series (RX 7600); Ryzen 7040-series integrated graphics and newer |
| Intel | Arc A-series (A310); Core Ultra integrated graphics and newer |

Everything older takes step 2 or 3. That is most cards in use today (GTX 10/16, RTX
20/30, RX 6000 and older, Steam Deck), so the fallback steps carry as much weight as
the first one.

Encoder settings are applied in two places on Windows: the profile on the target media
type, and rate control, B-frame count, GOP length and quality-versus-speed through the
encoder's `ICodecAPI`, fetched from the sink writer after the stream's input type is
set. Every `ICodecAPI` setting is best effort: a refused setting is skipped, never
fatal. If the sink writer refuses a target type outright, the export moves down the
ladder and tries again.

**Risk settled on 2026-10-11.** A throwaway probe on the development machine (RTX 4060)
wrote 1080p60 MP4 files through Media Foundation's own sink writer with hardware
transforms enabled, for all three codecs, with and without encoding parameters. ffprobe
read them back as AV1 Main, HEVC Main and H.264 **High**. So the sink writer accepts
AV1, and setting the profile on the target type is enough to leave Baseline. Two things
the probe also showed: the encoders ignored the B-frame request (no B-frames in any
file), and they overshot the requested bitrate by about 11% on noisy content, which the
size retry below has to absorb.

### Frame rate

`ExportOptions` gains `maxFps` (0 means no cap). Share copies pass 60.

The plan's rate ladder becomes: the source rate capped at `maxFps`, then 30. The old
"half the source rate" rule goes away.

When the output rate is below the source rate, frames are chosen on an even grid:
output frame *k* is the first source frame at or after *k / fps*, and it is stamped at
exactly *k / fps* with a duration of *1 / fps*. This replaces the slot-dedup loop and
gives constant-rate output from a variable-rate source. The picker is a pure function
in `export_budget.h` so it can be unit-tested and is shared by both platforms.

### Resolution

`PlanExport` keeps its approach (the largest standard height that still earns its
bitrate) but the bits-per-pixel floor depends on the codec: 0.05 for H.264 as today,
0.033 for HEVC, 0.03 for AV1. For the reference clip at 10MB that gives 1080p60 under
AV1 and HEVC (0.041) and 720p60 under H.264.

### Size

For any export with a real size limit:

- The first attempt aims at 94% of the limit.
- A result over the limit is retried lower, as today.
- A result under 88% of the limit is retried higher, unless the video bitrate already
  reached the source's bitrate. A copy never needs more bits than the clip it came from,
  so short or simple clips are allowed to come out small.
- At most three encodes. If the last one is under the limit it is published even when
  it is below 88%. If none fits, the export fails as today.

`RetryExportPlan` becomes symmetric and is covered by the existing unit test file.

### Editor saves stay as they are

The editor's full-quality save uses the same exporter with an unlimited budget. It
passes `codec: H264` and no `maxFps`, and the size window does not apply to it. It still
gains High profile. This matters because a saved edit is opened again by the trimmer,
which only accepts H.264.

### UI

The size menu, shared by the selection bar and the Watch view, gets one new entry:

| Entry | Limit | Codec |
|---|---|---|
| 10MB (Discord free) | 10 MiB | Auto |
| 10MB compatible (H.264) | 10 MiB | H264 |
| 50MB (Nitro Basic) | 50 MiB | Auto |
| 500MB (Nitro) | 500 MiB | Auto |

Menu options carry an id, a byte limit and a codec, where today they are a bare number.
The IPC call and the native binding take the codec as a new optional field.

The compatible copy is written as `<name> - 10MB H264.mp4` so both copies of one clip
can exist side by side.

The existing status note names the codec when `Auto` did not get AV1 ("Exported as
HEVC (no AV1 encoder on this GPU)", "Exported as H.264 (no AV1 encoder on this GPU)").
No dialog.

### Known limits

- A Windows user without an AV1 GPU gets HEVC from `Auto`. A viewer whose PC cannot
  decode HEVC, or who is on Linux, sees no picture in Discord. The compatible entry is
  for that case.
- AV1 and HEVC copies are end products: the trimmer refuses anything that is not H.264.
  This spec only checks that the refusal is a readable message, not a crash.

## Linux

Flash has a separate Linux exporter (`platform/linux/libav_muxer.cpp`, `Export`), built
on a private LGPL-only FFmpeg. It shares `export_budget.h` and `ExportOptions` with
Windows, so this piece changes Linux whether or not it means to. None of the Linux code
can be compiled or run on the development machine; the Ubuntu CI job compiles it, and
nothing has yet been run on Linux hardware (`docs/linux.md`). Everything below is
written to be compiled by CI and validated in phase L2, not verified here.

What Linux gets from the shared code, with a matching edit to the Linux exporter:

- The codec-aware plan, the 60 fps cap, the even-grid frame picker and the size window.
  The Linux exporter today makes one attempt and fails if it lands over the limit; it
  moves to the same three-attempt loop.
- The `codec` and `maxFps` options and the `codec` result field.

What Linux needs of its own:

- **An export encoder separate from the capture encoder.** Linux export currently reuses
  `CreateEncoder`, which is tuned for live capture: closed GOP, no B-frames, no
  lookahead. Export gets its own configuration: High profile, a longer GOP, variable
  bitrate with a peak, lookahead and the encoder's quality preset. B-frames stay off on
  Linux for now, because the Linux muxer takes the clip's end from the last packet in
  decode order and has never been run with reordered frames; turning them on is an L2
  item.
- **AV1 probe order** `av1_vaapi`, then `av1_nvenc`.
- **H.264 probe order** `h264_vaapi`, `h264_nvenc`, `libopenh264`, asking for High
  profile on the two hardware encoders. OpenH264 is limited to Constrained Baseline, so
  a Linux machine with no usable GPU encoder keeps today's quality. x264 would fix that
  and is excluded by the licence boundary in `docs/linux.md`.
- **Build recipe.** `scripts/build-linux-media.sh` enables an explicit codec list. It
  gains the `av1_vaapi` and `av1_nvenc` encoders. No new library is linked.

Distro differences that change the outcome:

| Distro family | GPU | AV1 encode (recent GPU) | H.264 encode |
|---|---|---|---|
| Any | NVIDIA proprietary driver | NVENC | NVENC |
| Debian, Ubuntu, Arch, SteamOS and derivatives | AMD or Intel | VA-API | VA-API |
| Fedora, openSUSE and derivatives | AMD (Mesa) | VA-API | **Off by default.** Mesa ships without the patented codecs; the user installs the "freeworld" VA drivers from RPM Fusion or Packman |
| Fedora | Intel | Needs the full `intel-media-driver` from RPM Fusion | Same |

AV1 is royalty-free, so the distros that strip H.264 and HEVC leave it alone. The gap
is a Fedora or openSUSE user on an AMD or Intel GPU too old for AV1: `Auto` lands on
OpenH264 and the copy looks like today's. The export note names the codec, and `docs/linux.md`
gains the package names. This table is from general knowledge of those distributions
and must be confirmed in L2. Flatpak and immutable distros (Bazzite, Silverblue) are L2
questions already listed in `docs/linux.md` and are not answered here.

## Files

- `packages/flash-capture/src/core/export_budget.h`: codec-aware plan, rate ladder,
  even-grid frame picker, symmetric retry.
- `packages/flash-capture/src/core/clip_exporter.h`: `codec` and `maxFps` options,
  `codec` in the result.
- `packages/flash-capture/src/platform/windows/clip_exporter.cpp`: codec ladder, encoder
  configuration, frame picking, the three-attempt loop.
- `packages/flash-capture/src/platform/linux/libav_muxer.cpp`, `libav_encoder.cpp`:
  export encoder configuration, codec ladder, three-attempt loop.
- `packages/flash-capture/src/binding.cpp`: parse and return the new fields.
- `apps/desktop/src/main/main.ts`, `src/preload/preload.ts`: pass the codec through,
  name the compatible copy.
- `apps/desktop/src/renderer/SelectionBar.tsx`, `FeedView.tsx`: the menu entries and the
  codec note.
- `scripts/build-linux-media.sh`, `docs/linux.md`: codec list, distro notes, L2 checks.

## Testing

Unit tests (`export_budget_test.cpp`), written before the code, portable, run on both
CI jobs:

- A 141 fps 1080p source at 10 MiB and 14.3 s plans 1080p60 for AV1 and HEVC and 720p60
  for H.264.
- `maxFps` 0 leaves the rate alone; a 30 fps source is never raised.
- The frame picker turns irregular timestamps into an even grid with no repeated and no
  out-of-order frames.
- Retry moves up when under 88%, down when over, and stops at the source bitrate.

Probe (`scripts/probes/`), Windows, against a real clip through the built addon:

- `Auto` reports `av1` on this machine and lands between 88% and 100% of the limit.
- `H264` reports `h264`.
- The existing export probes still pass, including the editor-save path.

Linux: the Ubuntu CI job proves the Linux exporter still compiles and the unit tests
pass. No Linux export is run by this piece. Running one on real hardware, per distro
family and GPU vendor, is added to the L2 checklist in `docs/linux.md`.

By hand (Windows):

- ffprobe on the outputs: AV1 at 60 fps, and H.264 **High**, not Baseline.
- HEVC cannot be reached on the development machine through `Auto`, because its GPU has
  AV1. A debug-only override forces each ladder step so HEVC and the fallbacks are
  exercised.
- The user watches Flash's AV1 copy of the reference clip next to
  `Flash-compare/D - AV1 1080p60.mp4`, then drops it into Discord and confirms it plays
  inline.
- Opening an AV1 copy in the editor shows a message and does not crash.
