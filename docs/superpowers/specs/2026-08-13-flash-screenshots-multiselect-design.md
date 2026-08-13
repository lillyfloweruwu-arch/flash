# Screenshots and multi-select

Date: 2026-08-13
Status: approved, not yet implemented

Two features for the Flash library: a screenshot that can be taken mid-game or
pulled out of an existing clip, and multi-select in the clip grid with bulk
actions.

They are specified together because they meet in the same place. Screenshots
land in the same grid as clips, so every part of the grid that assumed "one
item is one video" has to learn otherwise, and multi-select is the feature that
touches all of that surface at once. Building them separately would mean
building the grid's item-kind handling twice.

## Screenshots

### Where the pixels come from

The replay ring buffer stores encoded H.264 samples, not frames. Pulling a
still out of it would need a decode pass, which is the expensive way to solve
this and produces a frame the encoder has already been lossy about.

`CaptureLoop` already holds the raw BGRA texture every frame, on its way into
the NV12 conversion the encoder wants. That texture is the screenshot. The
capture loop keeps a copy of the most recent one in a member texture guarded by
a mutex, and overwrites it each frame. The cost is one `CopyResource` per frame
into an already-allocated texture, on the GPU, with no readback — the same
thing `WgcSource::DeliverLast` already does for its own reasons.

`saveScreenshot(path)` then copies that texture into a `D3D11_USAGE_STAGING`
texture, maps it for CPU read, and hands the pixels to WIC to encode as PNG.
The map is the only place this touches the CPU, and it happens on a worker
thread, not on the capture thread.

The screenshot comes out at whatever resolution capture is configured for, so a
1080p capture yields a 1080p PNG. This is deliberate — matching the capture
resolution means the screenshot shows exactly what the clip would have shown,
and it avoids a second capture path that could disagree with the first.

Files:

- `packages/flash-capture/src/capture/png_writer.h` / `.cpp` — new. Takes a
  staging texture's mapped pixels plus dimensions, writes a PNG. Links
  `windowscodecs.lib`.
- `packages/flash-capture/src/capture/screen_capture.h` / `.cpp` — stash the
  last raw frame; expose `SaveScreenshot(path)`.
- `packages/flash-capture/src/binding.cpp` — `saveScreenshot` export, wrapped in
  an async worker so the JS thread does not block on file IO.

### The two entry points

**Live hotkey.** Default `F9`, rebindable in Settings next to the existing clip
and short-clip hotkeys, registered through the same `registerHotkeys()` path.
Saves to the detected game's folder as `YYYY-MM-DD_HH-MM-SS.png`, matching the
clip naming exactly. On success it also:

- copies the image to the clipboard via `nativeImage.createFromPath`
- plays the same confirmation sound the clip hotkey plays
- flashes the overlay

The overlay flash is the one confirmation that is not self-contained: it does
nothing if the overlay is disabled. That is acceptable because the other two
still fire, but it means the overlay must not be the only feedback.

**Editor and player button.** `canvas.drawImage(video)` at the current playhead,
then `toBlob('image/png')`, then an IPC call that writes the bytes beside the
clip. No native code on this path at all. It exists because the most common
screenshot is of something you already decided was worth clipping.

### Screenshots in the library

`ClipInfo` gains `kind: 'clip' | 'shot'`. `getClips` scans for `.png` as well as
`.mp4` and tags each entry.

Screenshot entries carry `durationSec: 0`. This is not a placeholder — it makes
the existing "Longest" sort put screenshots at the bottom without a branch, and
it makes `formatDuration` render an em dash rather than `0:00`.

- `ClipCard` renders an `<img>` and a small image badge where a video would show
  its duration pill. The `suspend` prop that stops offscreen videos from
  exhausting Chromium's decoder budget does not apply to images and is ignored.
- The lightbox reuses the player shell — same top bar, same arrow keys moving
  across both kinds — and swaps `<video>` for `<img>`, hiding `PlayerControls`
  and the Trim and Editor buttons.

Arrow keys deliberately move across both kinds rather than staying within one.
The library is one list; making the arrow keys pretend otherwise would mean the
selection and the keyboard disagree about what comes next.

## Multi-select

### Selecting

Selection lives in `App` as a `Set<string>` of clip ids.

- Plain click opens the item, exactly as it does today. This does not change.
- Ctrl+click toggles one item into or out of the selection.
- Shift+click selects a range, in *displayed sort order* rather than in the
  underlying array order. Sorting by Longest and shift-clicking has to select
  what the eye saw between the two clicks.
- Ctrl+A selects everything currently visible, which means after the game
  filter and the search query, not the whole library.
- Escape clears.

A checkbox fades in on card hover and does the same job as Ctrl+click, for
when the modifier is not the first thing that comes to mind.

The range and toggle maths go in a new `apps/desktop/src/shared/selection.ts`
as pure functions, checked by asserts in the same style as `editor.ts` — a
toggle, a range across a sorted list, a range whose anchor is below its target,
and a clear.

### The selection bar

Slides up when the selection is non-empty. Shows the count, a clear button, and
four actions.

**Delete.** One `ConfirmDialog` for the whole selection rather than N dialogs.

**Drag to Discord.** The bar itself is the drag handle;
`startDrag({ files: [...] })` accepts the array, so this is a small change to
the existing single-file `start-clip-drag`.

**Export to size.** Runs the existing export over each selected clip in
sequence, showing `3/5` as it goes. Screenshots are skipped and the skip is
stated out loud: *"Exported 3 of 5 — 2 screenshots skipped."* Nothing is greyed
out and nothing silently does the wrong thing; the count says what happened
before and after the action.

**Move to game.** Reassigns which game folder the files live in, for clips
Flash misfiled. This overlaps the existing identify-game flow but does not
replace it: identify-game fixes detection going forward, this fixes files
already on disk. It stays in the selection bar because fixing a misdetection
usually means fixing the several clips it already produced, which is a
multi-select job by nature.

Mixed selections of clips and screenshots are allowed everywhere. Delete, drag
and move all work on both kinds; only export has a kind it cannot handle, and it
reports the skip rather than refusing.

## Verification

Both features have a piece that can be checked without a human looking at the
screen, and those are the pieces most likely to be wrong.

- `shared/selection.ts` gets assert-based self-checks, run the same way
  `editor.test.ts` is: `node --experimental-strip-types`.
- The native screenshot gets a probe under `packages/flash-capture/test/` that
  starts capture, writes a PNG, and asserts the file decodes at the expected
  dimensions and is not uniformly black. A black PNG is the exact failure this
  path is prone to, and it is the failure a passing "did it write a file" check
  would miss.

The renderer work — the card, the lightbox, the selection bar — is verified by
running it. There is no assertion worth writing about whether a checkbox fades
in.

## Deliberately not doing

- No screenshot editor, no annotation, no arrows or text. Screenshots go to the
  clipboard for pasting, which is what they are for.
- No configurable screenshot format. PNG only. JPEG would need a quality
  setting, which is a setting to explain for a file size nobody is counting.
- No select-all-across-filters. Ctrl+A means what is on screen.
- No undo for bulk delete. The confirm dialog is the undo.
