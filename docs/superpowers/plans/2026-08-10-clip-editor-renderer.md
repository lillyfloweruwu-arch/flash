# Clip editor renderer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the editor screen described in `docs/superpowers/specs/2026-08-10-flash-clip-editor-design.md` — a visual scrubber with frame-exact trim handles, a three-lane audio mixer that plays back live, and a saturation slider.

**Architecture:** A new screen, opened from the player, living in its own files rather than growing `App.tsx` (already 1127 lines). Native audio decode and keyframe listing reach the renderer through two new IPC channels. Live mixing runs in Web Audio because Chromium's `<video>` element decodes only the first audio track.

**Tech Stack:** Electron, React 19, Tailwind CSS v4, TypeScript, Web Audio API.

## Global constraints

- The native foundation from `2026-08-10-clip-editor-native-foundation.md` must be complete first. This plan consumes `DecodeClipAudio` and the frame-exact trimmer.
- **No new dependencies.** No waveform library, no slider library, no headless UI kit. Everything here is React, Canvas, and Web Audio.
- **No stock browser controls on this screen.** No `<video controls>`, no `<select>`, no `<input type="number">`. The point of the screen is that it does not look like a browser. `<input type="range">` is allowed *only* when fully restyled through `::-webkit-slider-thumb` and `::-webkit-slider-runnable-track`, because it carries keyboard and screen-reader support that a div cannot.
- Follow the existing style: inline `style={{}}` with CSS custom properties, Tailwind utilities for layout. Colours come from the existing vars — `--bg`, `--edge`, `--edge-soft`, `--muted`, `--muted-2`, `--muted-3`, `--faint`, `--accent`, `--accent-line`, `--alert`, `--field`. Never hardcode a hex.
- Video sources are `file://` URLs with backslashes replaced: `` `file://${filePath.replace(/\\/g, '/')}` ``. Match `App.tsx:311`.
- Tests are standalone: `import { strict as assert } from 'node:assert'`, run with `node --experimental-strip-types <file>`. Match `src/shared/accelerator.test.ts`. No test framework.
- Pure logic (time formatting, handle clamping, peak reduction, plan derivation) goes in `src/shared/` so it can be tested without a DOM. React components are not unit-tested.
- Commit messages follow the repo convention: `feat(editor):`, `fix(editor):`.

---

## File structure

**Created:**

| File | Responsibility |
|---|---|
| `src/shared/editor.ts` | Pure logic: timecode formatting, in/out clamping, keyframe snapping, peak reduction, save-mode derivation |
| `src/shared/editor.test.ts` | Self-check for the above |
| `src/renderer/Editor.tsx` | The screen: composition, state, save |
| `src/renderer/editor/Filmstrip.tsx` | Thumbnail strip, in/out handles, keyframe ticks, playhead |
| `src/renderer/editor/AudioLanes.tsx` | Three lanes: icon-as-mute, waveform canvas, gain slider |
| `src/renderer/editor/useLiveMix.ts` | Web Audio graph, synced to the video element clock |

**Modified:**

| File | Change |
|---|---|
| `packages/flash-capture/src/binding.cpp` | Expose `decodeClipAudio` and `getClipKeyframes` |
| `src/main/main.ts` | Two IPC handlers forwarding to the addon |
| `src/preload/preload.ts` | Two methods on `window.flash` |
| `src/renderer/global.d.ts` | Types for both |
| `src/renderer/App.tsx:321` | `Trim` button becomes `Editor`; opens the new screen |
| `src/renderer/App.tsx:232-236,343-372` | Delete the old numeric trim state and its inputs |

---

## Task 1: Bridge native audio and keyframes into the renderer

`DecodeClipAudio` exists in the addon but nothing calls it. The filmstrip also needs the keyframe list to draw its ticks and to tell the user when a save stays lossless.

**Files:**
- Modify: `packages/flash-capture/src/binding.cpp`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`

**Interfaces:**
- Produces:
  - `window.flash.decodeClipAudio(filePath: string): Promise<{ sampleRate: number; tracks: { id: string; samples: Float32Array }[] } | { error: string }>`
  - `window.flash.getClipKeyframes(filePath: string): Promise<{ keyframesSec: number[] } | { error: string }>`

- [ ] **Step 1: Add a keyframe lister to the addon**

`clip_trimmer.cpp` already walks samples checking `MFSampleExtension_CleanPoint` after Task 3 of the native plan. Extract that walk into a free function in `smart_render.h`/`.cpp` if it is not already one, and expose it. Do not duplicate the walk.

- [ ] **Step 2: Expose both through N-API**

In `binding.cpp`, alongside the existing `exports.Set` calls, add `decodeClipAudio` and `getClipKeyframes`. Both take a path string and both must run on a worker thread — decoding a 5-minute clip's audio takes long enough to stall the UI thread. Follow the `TrimClipAsync` / `AsyncWorker` pattern already in the file; do not do this work synchronously.

Return audio samples as a `Napi::Float32Array` per track so the renderer gets a zero-copy typed array rather than a JS number array. A 5-minute mono 22050 Hz track is 6.6 million samples; as a plain array that is roughly 50 MB of boxed doubles.

- [ ] **Step 3: Forward through main and preload**

`main.ts` gains two `ipcMain.handle` entries following the existing `trim-clip` / `export-clip` handlers, including their `{ error }` failure shape. `preload.ts` gains two matching methods. `global.d.ts` gains the types from the Interfaces block above.

- [ ] **Step 4: Verify against a real clip**

Add a temporary button, or run from the devtools console:

```js
const r = await window.flash.decodeClipAudio('<path to a real clip>')
console.log(r.sampleRate, r.tracks.map(t => [t.id, t.samples.length]))
```

Expected: `22050` and three tracks named `game`, `mic`, `other`, each with `sampleRate * durationSeconds` samples give or take a frame. Confirm `getClipKeyframes` returns ascending values roughly two seconds apart. Remove the temporary button before committing.

- [ ] **Step 5: Commit**

```bash
git add packages/flash-capture/src/binding.cpp apps/desktop/src/main/main.ts apps/desktop/src/preload/preload.ts apps/desktop/src/renderer/global.d.ts
git commit -m "feat(editor): bridge per-track audio and keyframes to the renderer"
```

---

## Task 2: Editor screen shell

**Files:**
- Create: `apps/desktop/src/shared/editor.ts`
- Create: `apps/desktop/src/shared/editor.test.ts`
- Create: `apps/desktop/src/renderer/Editor.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx:321`

**Interfaces:**
- Produces:
  - `formatTimecode(seconds: number): string` — `m:ss.d`
  - `clampRange(inSec: number, outSec: number, durationSec: number): { inSec: number; outSec: number }`
  - `<Editor clip={clip} onClose={() => void} onSaved={(path: string) => void} />`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/shared/editor.test.ts`:

```ts
// Self-check for editor maths. Run with:
//   node --experimental-strip-types src/shared/editor.test.ts
import { strict as assert } from 'node:assert'
import { formatTimecode, clampRange } from './editor.ts'

assert.equal(formatTimecode(0), '0:00.0')
assert.equal(formatTimecode(4.24), '0:04.2')
assert.equal(formatTimecode(65.98), '1:05.9')
assert.equal(formatTimecode(-3), '0:00.0')

// Out never precedes in, and neither escapes the clip.
assert.deepEqual(clampRange(2, 8, 30), { inSec: 2, outSec: 8 })
assert.deepEqual(clampRange(-5, 8, 30), { inSec: 0, outSec: 8 })
assert.deepEqual(clampRange(2, 99, 30), { inSec: 2, outSec: 30 })

// Dragging in past out pushes out along rather than inverting the range.
const crossed = clampRange(9, 8, 30)
assert.ok(crossed.outSec > crossed.inSec)

// A zero-length clip cannot produce a negative or NaN range.
const empty = clampRange(0, 0, 0)
assert.ok(Number.isFinite(empty.inSec) && Number.isFinite(empty.outSec))
assert.ok(empty.outSec >= empty.inSec)
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for `./editor.ts`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/shared/editor.ts`:

```ts
export function formatTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${Math.floor(rest).toString().padStart(2, '0')}.${Math.floor((rest % 1) * 10)}`
}

// Keeps the pair ordered and inside the clip. Dragging one handle past the
// other pushes the other along instead of inverting the range, which is what
// every editor does and what stops the strip rendering backwards.
//
// minSpanSec is not decoration: collapsing to zero length is what a naive
// clamp does when the handles cross, and the native trimmer rejects that with
// "trim range contains no decodable video". Keep a floor.
export function clampRange(inSec: number, outSec: number, durationSec: number, minSpanSec = 0.1) {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const clamp = (v: number, fallback: number) =>
    Math.min(Math.max(Number.isFinite(v) ? v : fallback, 0), duration)
  let start = clamp(inSec, 0)
  let end = clamp(outSec, duration)
  if (end - start < minSpanSec) {
    if (start + minSpanSec <= duration) {
      end = start + minSpanSec
    } else {
      end = duration
      start = Math.max(0, duration - minSpanSec)
    }
  }
  return { inSec: start, outSec: end }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: exits 0, no output.

- [ ] **Step 5: Build the screen shell**

Create `apps/desktop/src/renderer/Editor.tsx`. For this step it holds the video preview, the transport row, and the footer — the filmstrip and lanes arrive in later tasks.

- Full-screen overlay, same shape as `ClipPlayer` at `App.tsx:264`: `fixed inset-0 z-50 flex flex-col`.
- The `<video>` element has **no `controls` attribute** and is `muted`, because Task 4 routes audio through Web Audio and an unmuted element would play the game track twice.
- Transport row: a play/pause button, `formatTimecode(current) / formatTimecode(duration)`, and speed buttons `0.5x` `1x` `1.5x` `2x` writing to `video.playbackRate`. Speed is preview-only and is never saved.
- Escape closes. `Space` toggles play.
- Footer: `in → out`, the selection duration, and a `Save` button. Wiring comes in Task 6; for now `Save` is disabled.

- [ ] **Step 6: Replace the Trim button**

At `App.tsx:321`, the `Trim` button becomes `Editor` and opens this screen. Delete the old numeric trim state (`trimming`, `trimStart`, `trimEnd` at `App.tsx:232-235`) and the two `<input type="number">` controls and `Save trim` button that depend on it. Keep `trimNote` — the export flow still uses it.

Leave the `Export for sharing` button and its size dropdown alone; those stay on the player.

- [ ] **Step 7: Verify in the running app**

```bash
pnpm --filter "@flash/desktop" dev
```

Open a clip, press `Editor`. Confirm: the screen opens, the video plays with no browser control bar anywhere, the timecode advances, all four speed buttons change playback rate, Escape closes, and the old Start/End number boxes are gone from the player.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/shared/editor.ts apps/desktop/src/shared/editor.test.ts apps/desktop/src/renderer/Editor.tsx apps/desktop/src/renderer/App.tsx
git commit -m "feat(editor): editor screen shell, replacing the numeric trim inputs"
```

---

## Task 3: Filmstrip with handles and keyframe ticks

**Files:**
- Create: `apps/desktop/src/renderer/editor/Filmstrip.tsx`
- Modify: `apps/desktop/src/shared/editor.ts`
- Modify: `apps/desktop/src/shared/editor.test.ts`
- Modify: `apps/desktop/src/renderer/Editor.tsx`

**Interfaces:**
- Consumes: `clampRange`, `window.flash.getClipKeyframes`
- Produces:
  - `nearestKeyframe(keyframesSec: number[], seconds: number, toleranceSec: number): number | null`
  - `<Filmstrip clip inSec outSec keyframes currentSec onChange onScrub />`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/shared/editor.test.ts`:

```ts
import { nearestKeyframe } from './editor.ts'

const keys = [0, 2, 4, 6, 8]
assert.equal(nearestKeyframe(keys, 4.05, 0.25), 4)
assert.equal(nearestKeyframe(keys, 3.9, 0.25), 4)
assert.equal(nearestKeyframe(keys, 5, 0.25), null)      // too far from either
assert.equal(nearestKeyframe(keys, 8.1, 0.25), 8)
assert.equal(nearestKeyframe([], 4, 0.25), null)
assert.equal(nearestKeyframe(keys, 4, 0), 4)            // exact hit needs no tolerance
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: `nearestKeyframe is not a function`.

- [ ] **Step 3: Implement it**

Add to `apps/desktop/src/shared/editor.ts`:

```ts
// Returns the keyframe within tolerance of `seconds`, or null. Drives both the
// snap-on-drag behaviour and the lossless badge: a save is a pure remux only
// when the in-point lands exactly on one of these.
export function nearestKeyframe(keyframesSec: number[], seconds: number, toleranceSec: number): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const key of keyframesSec) {
    const distance = Math.abs(key - seconds)
    if (distance <= toleranceSec && distance < bestDistance) { best = key; bestDistance = distance }
  }
  return best
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: exits 0.

- [ ] **Step 5: Build the filmstrip**

Create `apps/desktop/src/renderer/editor/Filmstrip.tsx`.

- Thumbnails: render 8–12 `<video>` elements across the strip, each with the clip as `src`, `preload="metadata"`, `muted`, and `currentTime` set to its position. This is the technique already used for library thumbnails at `App.tsx:563` — reuse it rather than inventing a canvas extractor.
- Two draggable handles at the in and out positions. Dragging routes through `clampRange`. While dragging, if `nearestKeyframe(keys, position, 0.15)` returns a value, snap to it and mark that handle as snapped.
- Keyframe ticks: a 7px row under the strip, one 1px mark per keyframe, positioned by `time / duration`.
- The region outside the handles is dimmed with a translucent overlay.
- A playhead line tracks `currentSec`. Clicking anywhere on the strip scrubs there via `onScrub`.
- Handles are keyboard reachable: `tabIndex={0}`, arrow keys nudge by one frame, `Shift`+arrow by one second. This is why the handles are buttons and not bare divs.

- [ ] **Step 6: Verify in the running app**

Open the editor on a real clip. Confirm: thumbnails render across the strip, both handles drag and the dimmed region follows, the handles snap onto keyframe ticks when close, dragging the in handle past the out handle pushes it rather than inverting, clicking scrubs, and arrow keys move a focused handle.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/editor/Filmstrip.tsx apps/desktop/src/shared/editor.ts apps/desktop/src/shared/editor.test.ts apps/desktop/src/renderer/Editor.tsx
git commit -m "feat(editor): visual filmstrip with snapping trim handles"
```

---

## Task 4: Waveforms and live audio mixing

The feature Medal structurally cannot match, because it mixes at capture time.

**Files:**
- Create: `apps/desktop/src/renderer/editor/useLiveMix.ts`
- Create: `apps/desktop/src/renderer/editor/AudioLanes.tsx`
- Modify: `apps/desktop/src/shared/editor.ts`
- Modify: `apps/desktop/src/shared/editor.test.ts`
- Modify: `apps/desktop/src/renderer/Editor.tsx`

**Interfaces:**
- Consumes: `window.flash.decodeClipAudio`
- Produces:
  - `reducePeaks(samples: Float32Array, buckets: number): Float32Array`
  - `useLiveMix(videoRef, tracks, gains)` returning `{ ready: boolean }`
  - `<AudioLanes tracks gains onGainChange muted onMuteToggle />`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/shared/editor.test.ts`:

```ts
import { reducePeaks } from './editor.ts'

// One bucket per sample is the identity on magnitude.
const four = reducePeaks(new Float32Array([0, 0.5, -1, 0.25]), 4)
assert.equal(four.length, 4)
assert.equal(four[2], 1)                       // magnitude, not signed value

// Fewer buckets than samples keeps the peak of each span, not the mean —
// a single loud frame must stay visible after reduction.
const two = reducePeaks(new Float32Array([0, 0.1, 0.9, 0.2]), 2)
assert.equal(two.length, 2)
assert.equal(two[1], 0.9)

// More buckets than samples must not produce NaN or read off the end.
const wide = reducePeaks(new Float32Array([1]), 4)
assert.equal(wide.length, 4)
assert.ok(wide.every(Number.isFinite))

// Degenerate inputs return an empty result rather than throwing.
assert.equal(reducePeaks(new Float32Array([]), 8).length, 8)
assert.equal(reducePeaks(new Float32Array([1, 2]), 0).length, 0)
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: `reducePeaks is not a function`.

- [ ] **Step 3: Implement it**

Add to `apps/desktop/src/shared/editor.ts`:

```ts
// Peak per bucket, not mean. A mean waveform flattens exactly the thing the
// user is looking for — the one loud frame where something happened.
export function reducePeaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(0, buckets))
  if (!out.length || !samples.length) return out
  const span = samples.length / out.length
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * span)
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * span)))
    let peak = 0
    for (let j = start; j < end; j++) {
      const magnitude = Math.abs(samples[j])
      if (magnitude > peak) peak = magnitude
    }
    out[i] = peak
  }
  return out
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: exits 0.

- [ ] **Step 5: Build the mixing hook**

Create `apps/desktop/src/renderer/editor/useLiveMix.ts`.

- One `AudioContext`. Each decoded track becomes an `AudioBuffer` (mono, at the rate the addon reports) feeding an `AudioBufferSourceNode` into its own `GainNode`, all summed into `destination`.
- The video element is the clock and stays muted. On play, create and start all three source nodes together at `video.currentTime`. On pause, seek, or rate change, stop and discard them, then recreate on the next play — `AudioBufferSourceNode` is single-use and cannot be restarted.
- Gain changes write to `gainNode.gain.value` directly. Never rebuild the graph for a gain change; that is the whole point of the design.
- Apply `video.playbackRate` to each source's `playbackRate` so speed changes do not desync the mix.
- Clean up on unmount: stop every node and close the context. A leaked `AudioContext` per opened clip will exhaust the browser's limit within a session.

- [ ] **Step 6: Build the lanes**

Create `apps/desktop/src/renderer/editor/AudioLanes.tsx`.

- One row per track in `kAudioTrackOrder` order — `game`, `mic`, `other` — each with an icon, a label, a waveform, a gain slider and a numeric readout.
- **The icon is the mute button.** Clicking it toggles mute, draws an X over the icon, and drops the whole row to ~35% opacity including its waveform. No separate M button, and no solo button.
- Waveform: a `<canvas>` drawn from `reducePeaks`, 1px bars with 1px gaps, mirrored about a horizontal centre line. Redraw on resize, not on every frame.
- Gain slider: `<input type="range">` restyled through `::-webkit-slider-thumb` and `::-webkit-slider-runnable-track` so it keeps keyboard support without looking like a browser control.
- A track that came back empty renders a flat line and is disabled rather than blocking the screen.
- A clip with **no** audio tracks at all hides the mixer entirely rather than showing three dead lanes. The editor still opens and trimming still works.

- [ ] **Step 7: Verify in the running app**

Open a clip with real mic audio. Confirm: three lanes appear with distinct waveforms, the mic waveform visibly spikes where you spoke, clicking an icon mutes that track **and you hear the change immediately without saving**, the gain slider changes level in real time, muting dims the row and draws the X, audio stays in sync with video across seeks and speed changes, and no audio continues after closing the editor.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/editor/useLiveMix.ts apps/desktop/src/renderer/editor/AudioLanes.tsx apps/desktop/src/shared/editor.ts apps/desktop/src/shared/editor.test.ts apps/desktop/src/renderer/Editor.tsx
git commit -m "feat(editor): three-lane waveform mixer with live playback"
```

---

## Task 5: Saturation slider

**Files:**
- Modify: `apps/desktop/src/renderer/Editor.tsx`

- [ ] **Step 1: Add the row**

A single row directly under the keyframe ticks and above the audio lanes, using the same icon / label / slider / readout rhythm as a lane so the stack reads as one control group. It sits above the lanes, not among them, because it is a picture control and they are sound controls.

Range 0–200, default 100. Same restyled `<input type="range">` as the gain sliders.

- [ ] **Step 2: Apply it to the preview**

`filter: saturate(${saturation}%)` on the `<video>` element. Free, instant, no decode. At 100 the filter is omitted entirely rather than set to `saturate(100%)`, so the common case costs nothing.

- [ ] **Step 3: Verify**

Drag the slider. The preview desaturates to greyscale at 0 and intensifies at 200, with no stutter during playback. Double-clicking the slider returns it to 100.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/Editor.tsx
git commit -m "feat(editor): saturation slider with live preview"
```

---

## Task 6: Save, and the lossless badge

**Files:**
- Modify: `apps/desktop/src/shared/editor.ts`
- Modify: `apps/desktop/src/shared/editor.test.ts`
- Modify: `apps/desktop/src/renderer/Editor.tsx`
- Modify: `apps/desktop/src/preload/preload.ts`
- Modify: `apps/desktop/src/main/main.ts`

**Interfaces:**
- Produces: `deriveSaveMode(inOnKeyframe: boolean, gains: number[], saturation: number): { lossless: boolean; reason: 'none' | 'trim' | 'audio' | 'video' }`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/shared/editor.test.ts`:

```ts
import { deriveSaveMode } from './editor.ts'

// Nothing changed but the cut, and the cut is on a keyframe: pure remux.
assert.deepEqual(deriveSaveMode(true, [1, 1, 1], 100), { lossless: true, reason: 'none' })

// Off-keyframe in-point costs a head re-encode only.
assert.deepEqual(deriveSaveMode(false, [1, 1, 1], 100), { lossless: false, reason: 'trim' })

// A gain change re-encodes audio — cheap, seconds.
assert.deepEqual(deriveSaveMode(true, [1, 0, 1], 100), { lossless: false, reason: 'audio' })

// Saturation re-encodes every frame — the expensive one, and it must win
// the reported reason so the user is told the worse cost, not the milder one.
assert.deepEqual(deriveSaveMode(true, [1, 1, 1], 120), { lossless: false, reason: 'video' })
assert.deepEqual(deriveSaveMode(false, [1, 0, 1], 80), { lossless: false, reason: 'video' })
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: `deriveSaveMode is not a function`.

- [ ] **Step 3: Implement it**

Add to `apps/desktop/src/shared/editor.ts`:

```ts
// Reports the most expensive thing the save will do, not the first one found.
// Video re-encode dominates audio, which dominates a head-only trim encode.
export function deriveSaveMode(inOnKeyframe: boolean, gains: number[], saturation: number) {
  if (saturation !== 100) return { lossless: false, reason: 'video' as const }
  if (gains.some(g => g !== 1)) return { lossless: false, reason: 'audio' as const }
  if (!inOnKeyframe) return { lossless: false, reason: 'trim' as const }
  return { lossless: true, reason: 'none' as const }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --experimental-strip-types apps/desktop/src/shared/editor.test.ts
```

Expected: exits 0.

- [ ] **Step 5: Extend the save bridge**

`trimClip` currently takes `(filePath, start, end)`. Add gains and saturation, defaulting to unity and 100 so existing callers keep working. Route saves through the export path when `reason` is `audio` or `video`, since that path already decodes, mixes and re-encodes; route through the trimmer when `reason` is `none` or `trim`.

- [ ] **Step 6: Wire the footer**

Footer shows `in → out`, the selection duration, and the badge from `deriveSaveMode`:

- `reason: 'none'` — a `lossless` badge in `--accent`
- `reason: 'trim'` — `re-encoding 2s at the start`
- `reason: 'audio'` — `re-encoding audio`
- `reason: 'video'` — `re-encoding video — saturation`

Save writes a new file and leaves the original alone. While saving, the button shows progress and the screen stays open; on success, report the new path and close.

If smart render fails, the native side degrades to a keyframe-snapped trim and reports the in-point it actually used. Surface that rather than swallowing it: `saved from 0:04.0 — 0.2s earlier than asked`. Silently delivering a different cut than the one on screen is the exact behaviour this screen exists to remove.

- [ ] **Step 7: Verify all four paths**

For each, save and confirm the badge matched what actually happened, the output plays, and the original is untouched:

1. In-point on a keyframe, no gain or saturation change — near-instant, `lossless` badge.
2. In-point off a keyframe — starts on the requested frame, no visible seam.
3. `other` muted — Discord audio gone from the saved file, game and mic intact.
4. Saturation at 50 — visibly desaturated output.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/shared/editor.ts apps/desktop/src/shared/editor.test.ts apps/desktop/src/renderer/Editor.tsx apps/desktop/src/preload/preload.ts apps/desktop/src/main/main.ts
git commit -m "feat(editor): save with gain and saturation, and an honest lossless badge"
```

---

## Definition of done

- `node --experimental-strip-types apps/desktop/src/shared/editor.test.ts` exits 0.
- The editor screen contains no `<video controls>`, no `<select>`, and no `<input type="number">`.
- Muting a track changes what you hear immediately, without saving.
- An off-keyframe in-point saves starting on the requested frame with no visible seam.
- The `lossless` badge is correct for all four save paths.
- No `AudioContext` survives closing the editor.
