# Probes

Small programs that drive the real capture addon and measure what it does.

`pnpm test` proves the pure logic. These prove the parts that only fail against
real hardware, a real desktop and real arguments — which is where most of this
app's bugs have actually been. Every one of them was written because reading the
code was not enough:

| Probe | What it caught |
|---|---|
| `every-native-path.js` | The editor's full-quality save failed for every clip, because it passes `Number.MAX_SAFE_INTEGER` as a size budget and nothing else does |
| `trim-on-keyframes.js` | Trimming to a keyframe landed a GOP early on half of them |
| `trim-offsets.js` | The same failures at every request offset, which is what ruled out a rounding miss |
| `display-mode-change.js` | A resolution change recorded the new desktop in the corner of the old one |
| `audio-track-gap.js` | `saveClip` hung forever when a track stopped mid-recording |
| `audio-toggle.js` | The Audio capture switch had never done anything |
| `audio-all-tracks-off.js` | `saveClip` hung again when EVERY track stopped, which the toggle does in one click |
| `audio-starts-late.js` | And again when audio was switched ON partway, so the tracks started late |
| `audio-lands-in-place.js` | That filling the gaps does not move or flatten the real audio |
| `audio-under-load.js` | A timestamp defect that is real in the code and does not show up in the output |
| `process-list-vs-tasklist.js` | That the native process list agrees with `tasklist` on 330 of 332 processes |

They are not part of `pnpm test`: they need a live desktop, they record the
screen, and several take half a minute each. Run them by hand.

    node scripts/probes/every-native-path.js
    node scripts/probes/record-and-save.js

Each one records to scratch directories under the system temp folder and deletes
them on the way out. `display-mode-change.js` changes the display resolution and
puts it back; if it is killed partway, restore it with:

    powershell -File scripts/probes/set-resolution.ps1 -Width 1920 -Height 1080

`display-mode-change.js` writes PNGs to `scripts/probes/out/` and leaves them
there, because the point of it is to look at them.

## Writing another one

Require `./addon`, which finds the built addon relative to the probe and says
how to build it if it is missing. Print numbers rather than verdicts wherever
the number is the interesting part — "drift 0.0000s" survives being pasted into
a commit message, "ok" does not.
