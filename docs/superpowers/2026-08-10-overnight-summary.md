# Overnight summary — 2026-08-10

Branch: `clip-editor-native-foundation`, nine commits, nothing pushed and nothing merged to `master`.

The native foundation for the clip editor is complete. The renderer is planned but not built.

## What landed

| Commit | What |
|---|---|
| `8c41efe` | Colour fix: record BT.709 limited and tag it |
| `2b72371` | Write all three audio tracks so mixer lanes stay aligned |
| `a875a4a` | Decode clip audio tracks separately for preview |
| `f258907` | Plan frame-exact trims around keyframe boundaries |
| `5553caf` | Keep assertions live in Release test builds |
| `14f0a14` | Clip editor spec and native foundation plan |
| `3edd8cc` | Frame-exact trims via smart render of the head fragment |
| `5dc9d0d` | Per-track gain and saturation on export |
| `eaa40f7` | Implementation plan for the clip editor renderer |

## The oversaturation bug is fixed and proven

Clips were converted with the BT.601 matrix and tagged with nothing, so every
player decoded them as BT.709 and amplified chroma. Recording now converts as
BT.709 limited and says so on every media type.

Verified by recording through the real NVIDIA H.264 Encoder MFT: the new clip
carries `colr nclx primaries=1 transfer=1 matrix=1` with the full-range flag
clear. Three older clips carry no colour box at all.

**Your installed app still has the old addon.** `C:\Program Files\Flash` bundles
its own copy, so day-to-day recordings are still untagged until it is
repackaged and reinstalled. I did not do that while you were asleep.

## Bugs found, with evidence

**A 50-microsecond miss cost 259x.** The frame-exact trim planner tested for
"is this in-point a keyframe" with an exact integer match. Real keyframes land
on values like 3728650us, never round numbers. Asking for 3728700 — fifty
microseconds later — missed and re-encoded the entire GOP.

    on a keyframe        3.728650s     93ms    2.6MB
    fifty us later       3.728700s   24068ms    5.4MB
    after the fix        3.728700s     87ms    2.6MB

This was my bug, not Codex's; I wrote that line in the plan and it was
implemented faithfully. The match now carries a tolerance of half a frame.

**Saturation was biased upward.** Rounding with a plain `+ 50` rounds correctly
only above neutral. Below it, integer division truncates toward zero and every
sample lands one step high, tinting the whole chroma plane. Found by running
the function's own test vectors before trusting them. Rounding is now half away
from zero, and the self-check sweeps every non-clamping value for symmetry.

**Your entire test suite was reporting green without checking anything.** CMake's
Release config passes `/DNDEBUG`, which compiles every `assert` to nothing.
Every test here is a bare `main()` with `<cassert>`, so all of them exited 0
regardless. Codex found this, and it was real. Fixed with `/UNDEBUG`.

Two tests fail now that their assertions execute. Both predate all of this:

- `ring_buffer_test.cpp:82` — the retained span is not the expected four seconds
- `export_budget_test.cpp:18` — the export planner allocates a bitrate below its
  own quality floor, which plausibly affects clips you are already sharing

You started a separate session on those. Task 4 deliberately ended up touching
neither file, so there is no conflict: `export_budget.h` and its test have zero
net diff on this branch.

**Silent audio tracks were being dropped.** A clip recorded with the mic off but
Discord playing contained `game` and `other` as streams 0 and 1, and the editor
maps lanes by position, so muting "mic" would have muted Discord. Adding the
stream was not enough on its own — `IMFSinkWriter::Finalize` drops a stream that
never receives a sample. Silent tracks now get the reference track's packet
timing filled with zeroes.

## Known issue, not fixed

The re-encoded head fragment encodes at roughly four times the source bitrate
(12.6 Mbps against 3.1). `ConfigureEncoder` copies `MF_MT_AVG_BITRATE` from the
source media type, and an MP4's native H.264 type does not carry it. The
keyframe pass now measures the real rate and passes it on, and the encoder
accepts it — both `CODECAPI_AVEncCommonRateControlMode` and
`CODECAPI_AVEncCommonMeanBitRate` return `S_OK` — and then ignores it.

Consequences are mild: the head looks better than the body rather than worse,
and mid-GOP trims produce a larger file than they need to. Worth chasing when
the head moves to the hardware encoder, which is the same change that would fix
the encode speed.

Related: `MFT_ENUM_FLAG_SYNCMFT` selects a software encoder, because hardware
NVENC MFTs are asynchronous and excluded by that flag. `mf_hardware_encoder.cpp`
already implements the async MFT event protocol. Reusing it would make mid-GOP
trims faster and let the bitrate actually take effect.

## Verification

Six of eight native self-checks pass; the two failures are the pre-existing ones
above. The addon links with no warnings from any file in this package.

Trims, measured on a real 30s clip with keyframes every 3.7s:

    in-point on a keyframe        94ms   pure remux
    in-point 50us off one         95ms   pure remux
    in-point mid-GOP             692ms   frame-exact, drift 0.000s
    short range inside one GOP   528ms   frame-exact, drift 0.000s

All outputs carry the colour box and all three audio tracks.

Export, on the same clip:

- Mean luma is unchanged to three decimals across saturation 0, 100 and 180,
  while mean chroma goes flat at 0 and spreads at 180. The operation provably
  touches colour and nothing else.
- Muting the mic drops the mixdown from rms 0.055 to rms 0.0006.

## What I did not do

- **No push, no merge to `master`, no reinstall over `C:\Program Files\Flash`.**
  A bad build landing in your installed app while you sleep is not a trade worth
  making. Everything is on the branch, ready to merge in one command.
- **The renderer is planned but not built.** The plan is at
  `docs/superpowers/plans/2026-08-10-clip-editor-renderer.md`, six tasks, every
  pure function already validated against its own test vectors. I did not build
  it because it is the part where how it feels matters, and that needs your eye.
- **I stopped delegating to Codex after Task 3.** Its forwarder detached on all
  three handoffs, cannot verify its own work or block on the jobs it spawns, and
  hung for an hour after delivering Task 3's files. Task 4 was faster to write
  than to review.

## Codex scores

- **Task 1, audio decode — 7/10.** Careful Media Foundation work, no invented
  scope. Lost points for never once calling the function it wrote, and for
  correctly diagnosing the `NDEBUG` bug then suppressing the warnings instead of
  fixing it.
- **Task 2, trim planner — 9/10.** Exact, test not weakened, mutation test
  actually performed. Mostly transcription, so it measures fidelity rather than
  judgment. Lost a point because its report reached me empty.
- **Task 3, smart render — 8/10.** The hard one, and largely right: a separate
  reader so the copy path keeps its converters disabled, a whitelist of copied
  attributes that avoids the SPS/PPS trap, colour tags on all three media types,
  and a transactional buffer that only publishes the head once the first IDR is
  confirmed. That last part is better than what I specified. Lost points for the
  software-only encoder and the unvalidated bitrate, both of which I found by
  measuring rather than reading.

## Next

1. Merge the branch, or review it first — `git log --oneline master..HEAD`.
2. Repackage and reinstall so your own recordings get the colour fix.
3. Build the renderer, starting with Task 1 of the renderer plan.

Left behind: three small diagnostic binaries under
`C:\Users\emers\AppData\Local\flash-probes` — a keyframe lister, a per-frame
YUV mean probe, and a per-track audio decoder. They are what produced the
numbers above and are reusable. Delete the folder if you would rather not keep
them.
