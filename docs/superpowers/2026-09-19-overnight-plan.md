# Overnight plan — 2026-09-19

Mandate: bulletproof + feel better + new capability + lean. Package, back up, install
over C:\Program Files\Flash at the end, confirm it launches, restore the backup if not.

Working branch: clip-editor-native-foundation.

## A — Bulletproof (engine)

- [ ] A1 WASAPI packet timestamps: a backlog gives several packets the same time
- [ ] A2 Encoder input texture reused before the async MFT releases its sample
- [ ] A3 WGC never checks ContentSize; a mid-recording resolution change breaks capture
- [ ] A4 Default audio device change is not followed
- [ ] A5 decodeClipAudio ignores timestamps, so a late mic track draws early
- [ ] A6 Trimming to a reported keyframe lands a GOP early on ~half of them
- [ ] A7 Prove the watchdog recovers from FrameSource::Failure() and from a dead encoder
- [ ] A8 Move the measurement harnesses into the repo; run tests from a hook

## B — Feel better (UI)

- [ ] B1 Actually look at every screen, at more than one window size
- [ ] B2 Fix what the look turns up
- [ ] B3 Clip with no audio tracks: check the mixer does not draw nonsense

## C — New capability

- [ ] C1 Pick from the design spec's unbuilt phases, say why

## D — Lean

- [ ] D1 The installer is 180MB against a <100MB promise. Audit what ships.
- [ ] D2 Measure idle CPU and memory

## E — Ship

- [ ] E1 pnpm package
- [ ] E2 Back up C:\Program Files\Flash to a dated folder
- [ ] E3 Install, launch, confirm capture starts and a clip saves
- [ ] E4 Restore the backup if any of that fails
