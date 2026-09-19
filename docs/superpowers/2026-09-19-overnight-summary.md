# Overnight summary — 2026-09-19

Branch `clip-editor-native-foundation`, 20 commits.
Nothing pushed, nothing merged to `master`.

**Installed 19 September at 19:30**, after the user accepted the UAC prompt the
overnight session could not. `C:\Program Files\Flash` went from the 14 August
build at 278.3 MB to this one at 231.3 MB, and was checked through the installed
binary itself: recording and healthy on NVENC through Windows.Graphics.Capture,
a 15-second save carrying all three audio tracks and 15 keyframes, settings
intact, test clip removed.

    release\Flash Setup 0.1.0.exe        70.9 MB, signed
    C:\Users\emers\Flash-backup-2026-09-19   the current install, copied before touching anything

The build it replaced was from 14 August and predated voice activation,
screenshots, multi-select, per-game settings and clip renaming as well as all of
this. The backup folder is a straight copy if it is ever needed.

## What was broken and now is not

**The editor's full-quality save had never worked.** Saving an edit that changes
audio gains or saturation passes `Number.MAX_SAFE_INTEGER` as a size budget,
which became a bitrate of about 1.7e13 kbps, overflowed the uint32 holding it,
and the encoder refused the media type. Every such save failed.

**A display mode change corrupted the recording.** A game switching resolution
left the frame pool at the old size, so the new desktop arrived pasted into the
top-left corner of a buffer still holding the old picture — frames with two
taskbars in them — while capture reported healthy throughout.

**`saveClip` hung forever when audio did not span the whole clip.** Three
variants, all of them reachable from the one switch in Settings: a track that
stopped, every track stopping at once, and audio switched back on partway so the
tracks start late. In each case IMFSinkWriter waits for the stream that does not
reach the end, Finalize is never called, and the clip key simply stops working
for the rest of the session with no error anywhere. Silence now covers the
video's whole span, and a check confirms it does not move or flatten the real
audio it fills around.

**Trimming to a keyframe landed a GOP early on half of them.** Asking for a
keyframe the app itself reported gave 1.02 seconds of footage nobody asked for,
on the same keyframes every time.

**The Audio capture switch did nothing at all.** It persisted a boolean that no
code read.

**Screenshots never appeared in the library**, clips with `#` in the name never
played, the hidden player kept playing under the editor, and thumbnail decoders
were never released, so a long scroll ended with black tiles.

**Eleven handlers used `startsWith` as a directory check**, which accepts a
sibling folder that shares the name and a `..` traversal, and refuses a real
clip whose path differs only in case. `open-clip` passed renderer paths straight
to `shell.openPath`, which runs an executable.

## What is faster, smaller and easier to read

| | before | after |
|---|---|---|
| Game detection, per poll, every 3s | 648ms + 627ms of child processes | 21ms, native |
| Installed size | 278.3 MB | 231.0 MB |
| `app.asar` | 8.00 MB | 0.76 MB |
| Clip titles | `2026 09 13 02 45 12` | `13 Sep · 2:45:12 AM` |

Detection spawned `tasklist` and two PowerShell scripts every three seconds for
as long as the app was open, and the worst case was an idle machine, because
that is when nothing matches and both run.

## What is new

Clips can be starred, and starred clips are exempt from auto-delete. The flag
lives in the clip's own sidecar, so it survives a settings reset and travels
with the file.

## Proof it works, end to end, in the packaged build

The trimmed package was launched and driven through its own bridge:

    editor save, re-encoding   saturation 130, mic gain 0.5, 2s..6s -> 4.007s
    editor save, lossless      2s..6s -> 4.013s, actual start exactly 2.000s
    capture                    recording, healthy, NVENC through Windows.Graphics.Capture
    library                    8 clips listed, starring writes through to the sidecar
    audio off then on, save    15.00s with all three tracks, where it used to hang

The first of those is the save that had never worked. The second shows the trim
landing exactly where it was asked to rather than a GOP early. Every clip the
tests created was deleted afterwards, so the library holds the same 8 it did.

## What is deliberately not done

- **The encoder's input texture pool** can be reused before the asynchronous
  encoder releases the sample pointing at it. Real, but it needs more than four
  outstanding samples to bite, which could not be staged, and the fix allocates
  a 1080p texture per frame on the encode hot path.
- **WASAPI packets are timestamped at drain time.** Real in the code. Recording
  under sixteen busy processes and comparing each audio track against the video
  showed a shortfall of 3 milliseconds, so it does not show up in the output,
  and rewriting A/V sync without a reproduction is the wrong trade.
- **A default audio device change** is not followed. Staging it means disabling
  the machine's audio device, which is not something to get wrong unattended.
- **Watchdog recovery is not proven** for either failure path. Both need a fault
  that cannot be staged from software.
- **231 MB is not the under-100 MB this project wants.** Chromium is 180 MB of
  it. That is a decision about the shell, not something to shave at.

## How this was found

Two Codex audits, twelve findings each, every one verified here before anything
was touched — Codex called one of its own findings NOT REAL once it had been
fixed, and said plainly which part of the keyframe measurement it could not
account for. The local model got two tasks: the first failed its own test, the
second was correct after restyling.

The largest finds came from neither. They came from running the real engine with
the arguments the app actually sends, and from looking at screenshots of the
real window. Those programs are now in `scripts/probes/`, with a README saying
what each one caught.
