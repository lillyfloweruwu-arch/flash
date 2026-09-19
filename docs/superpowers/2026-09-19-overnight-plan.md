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
- [ ] A4 Default audio device change — NOT ATTEMPTED. Switching or disabling the default
      endpoint needs either a second device or a device-disable, and getting that wrong
      while the user is asleep leaves the machine with no audio. Left for a session where
      someone can unplug a headset by hand.
- [x] A5 Track alignment — checked and correct, and it turned up a hang instead.
      Recording with the microphone on for 10s then off for 10s made saveClip hang
      forever. Once fixed, the decoded mic track carries its energy in the first five
      2-second windows (0.0004, 0.0004, 0.0003, 0.0005, 0.0005) and exactly zero in the
      last five - the right half, not shifted.
- [x] A6 Keyframe trim drift — FIXED. IMFSourceReader::SetCurrentPosition is documented as
      approximate and can land on the keyframe BEFORE the one asked for; that sample is a
      clean point too, so the existing check accepted it. The trimmer now reads forward to
      the sample the plan meant. All 7 keyframes x 5 offsets now land exactly, and asking
      1ms BEFORE a keyframe now snaps forward to it (+0.001s) instead of falling back a
      whole GOP (-1.021s). Mid-GOP trims stay frame-exact; remuxes stay ~90ms.
- [ ] A7 Watchdog recovery — NOT PROVEN. Both paths need a fault that cannot be staged
      from software: a monitor physically disconnected, and an encoder that dies. The
      display mode change exercises the restart path but not the failure path.
- [x] A8 Harnesses moved to scripts/probes/ with a README saying what each one caught.
      Not wired into `pnpm test`: they need a live desktop and record the screen.

## B — Feel better (UI)

- [x] B1 Looked at the library, settings, player and editor by driving the real packaged
      app over the DevTools protocol and reading the screenshots.
- [x] B2 What the look turned up: every card was headed with six raw numbers, and the
      short-clip hotkey claimed "last 60s" against a 15s buffer. Both fixed.
- [ ] B3 Not checked: a clip with no audio tracks at all in the editor's mixer.

## C — New capability

- [x] C1 Starred clips, with auto-delete exemption. Picked over the spec's bigger unbuilt
      phases because auto-delete could already eat a clip the user cared about, and there
      was no way to say "keep this one". State lives in the clip's own sidecar, so it
      survives a settings reset and travels with the file.

## D — Lean

- [x] D1 Installed size 278.3 MB -> 231.0 MB. 40.3 MB of unused locale packs, 7.6 MB of
      react-dom shipped twice. Chromium is 180 MB of what remains and under-100 MB is not
      reachable while the shell is Electron.
- [x] D2 Idle cost was measured earlier and fixed: game detection spent ~1.3s of child
      process work every 3s and now takes 21ms.

## E — Ship

- [x] E1 Packaged. release/Flash Setup 0.1.0.exe, 70.9 MB, signed.
- [x] E2 Backed up to C:\Users\emers\Flash-backup-2026-09-19 (96 files, 278.3 MB).
- [ ] E3 BLOCKED, not failed: the NSIS package is perMachine, so installing needs a UAC
      prompt and this session is not elevated (verified: cannot write to Program Files).
      The payload itself is verified - release/win-unpacked/Flash.exe was launched, the
      renderer loaded, the library listed clips, capture came up healthy on NVENC through
      WGC, and a clip saved and decoded at the right length. One double-click finishes it.
- [ ] E4 Not needed unless E3 is run.
