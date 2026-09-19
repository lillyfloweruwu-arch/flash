# Overnight plan — 2026-09-19

Mandate: bulletproof + feel better + new capability + lean. Package, back up, install
over C:\Program Files\Flash at the end, confirm it launches, restore the backup if not.

Working branch: clip-editor-native-foundation.

## A — Bulletproof (engine)

- [x] A1 WASAPI packet timestamps — NOT REPRODUCED, left alone.
      Recorded 18s idle and 18s under 16 busy processes, then compared each decoded audio
      track against the video duration. Shortfall was -0.004s idle and -0.003s loaded, so
      the audio timeline does not lose the backlog's time on this machine even at high
      load. The drain-time stamping is theoretically wrong; it is not measurably wrong.
      Rewriting A/V sync without a reproduction is the wrong trade.
- [x] A2 Encoder input texture reuse — left alone, deliberately.
      Needs more than kInputPool (4) samples outstanding at once, which could not be
      staged. The proposed fix allocates a 1080p texture per frame on the encode hot path:
      a certain, permanent cost against a fault with no reproduction. A refcount-probing
      variant was considered and rejected as too clever for an unverifiable win.
- [x] A3 Display mode change — FIXED and proven with screenshots through the capture path.
      Before: a 1920x1080 frame with the new 1280x720 desktop in the corner and stale 1080p
      content filling the rest. After: a clean 1280x720 frame, sizes varying between shots.
      Direct3D11CaptureFramePool::Recreate froze delivery for six seconds and was rejected;
      the source is torn down and restarted instead.
- [ ] A4 Default audio device change is not followed
- [ ] A5 decodeClipAudio ignores timestamps, so a late mic track draws early
- [x] A6 Keyframe trim drift — FIXED. IMFSourceReader::SetCurrentPosition is documented as
      approximate and can land on the keyframe BEFORE the one asked for; that sample is a
      clean point too, so the existing check accepted it. The trimmer now reads forward to
      the sample the plan meant. All 7 keyframes x 5 offsets now land exactly, and asking
      1ms BEFORE a keyframe now snaps forward to it (+0.001s) instead of falling back a
      whole GOP (-1.021s). Mid-GOP trims stay frame-exact; remuxes stay ~90ms.
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
