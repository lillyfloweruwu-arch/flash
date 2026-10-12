# Probes

Small programs that drive the real capture addon and measure what it does.

`pnpm test` runs pure checks and safe integrations: sidecars, preload subscriptions,
main-process boundary injections, a temporary Windows deny-delete handle, native
publication fixtures, and `export-and-game.js --safe`. The safe export mode checks
output refusal and failure cleanup without initializing capture; it skips cleanly
when the addon is absent. The Windows lock test skips on other platforms.

The remaining probes exercise real hardware and the desktop:

| Probe | What it caught |
|---|---|
| `sidecars.js` | Legacy migration preserves stars, corrupt metadata protects clips, and output reservations cannot collide |
| `export-and-game.js` | Repeated exports and trims coexist, failed exports leave no partials, and game identity survives an in-flight save |
| `preload-subscriptions.js` | All preload event subscriptions remove their listeners across repeated mounts |
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
| `audio-lanes.js` | A tone played by a helper process lands on the Music track, moves to Discord when reassigned, and every lane obeys the Record audio switch |
| `track-order.js` | Decode, export and trim read a clip's audio tracks in the reader's order, not the file's, which swapped Game and Other in the editor |

Live recording and the native screenshot probe are skipped by default. Set
`FLASH_HARDWARE_TESTS=1` to include the capture/export, screenshot and idle-reset
regression gates, or run them individually. They record the screen and can take
half a minute. The idle-reset probe must remain in the reviewer acceptance gate.

    node scripts/probes/every-native-path.js
    node scripts/probes/record-and-save.js
    node --experimental-strip-types scripts/probes/sidecars.js
    node --experimental-strip-types scripts/probes/export-and-game.js
    node scripts/probes/preload-subscriptions.js

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

## Renderer and package acceptance

Run `apps/desktop/node_modules/electron/dist/electron.exe scripts/probes/renderer-controls.js`
on Windows for the isolated Chromium keyboard/layout checks. It mounts the actual
React controls, uses native key events, checks a 900?600 viewport and 150% zoom,
and loads all six toast/overlay themes with the bundled font and reduced motion.
It does not start the Flash application or capture engine. It requires an Electron
installation that Windows permits renderer sandbox processes to read.

`main-boundaries.js` exercises the actual save/protocol/window functions with
injected service failures; this is not evidence of packaged seeking, real focus
retention or clipboard paste. The reviewer still owns the fresh Windows package,
hidden Watch/Editor audio, autostart, sleep/resume, global shortcuts, tray and DPI,
Explorer/chat drag, clipboard paste, multi-monitor placement and clean shutdown.
