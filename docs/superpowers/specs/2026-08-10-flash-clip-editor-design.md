# Flash clip editor — design

Date: 2026-08-10
Status: approved, not yet implemented

## Goal

Replace the two number boxes behind the current `Trim` button with a dedicated
editor screen: a visual scrubber, frame-exact trim points, and a three-lane
audio mixer that plays back live.

## What this is, and what it is not

This is a **finisher**, not an editor. One clip goes in, one clip comes out.

The rule that settles every future scope argument: **if a feature needs a second
source file, it does not belong here.** That excludes multi-clip timelines,
transitions, text overlays, subtitles, music beds, stickers, and VFX. Those are
what CapCut and DaVinci already do better, for free.

What Flash can do that they cannot is mix the game, mic and Discord tracks
separately, because Flash records them separately. That is the differentiator,
and it is where the effort goes.

## Entry point

The `Trim` button in the player becomes `Editor`. It opens a separate screen —
the player is left alone. Closing the editor returns to the player.

## Layout

Top to bottom, one column:

1. **Preview** — the clip, muted. All audio routes through Web Audio instead
   (see Live mixing).
2. **Transport** — play/pause, `current / total` timecode, and speed buttons
   `0.5x` `1x` `1.5x` `2x`. Speed affects preview only; it is not baked into the
   saved file.
3. **Filmstrip** — thumbnails across the clip's full duration, with draggable
   in and out handles. The region outside the handles is dimmed. A playhead
   line tracks the preview.
4. **Keyframe ticks** — a thin row under the filmstrip marking every keyframe.
   When both handles sit on ticks and every gain is unity, the footer shows a
   `lossless` badge, because the save is a pure remux.
5. **Saturation** — a single row directly under the keyframe ticks, using the
   same icon / label / slider / readout rhythm as an audio lane so the two
   groups read as one control stack. It sits above the lanes, not among them,
   because it is a picture control and they are sound controls. Default 100,
   range 0 to 200. Applies live to the preview.
6. **Audio lanes** — three rows: `game`, `mic`, `other`. Each row is an icon, a
   label, a waveform, a gain slider and a numeric readout.
7. **Footer** — `in → out`, selection duration, the `lossless` badge when it
   applies, the existing export-size dropdown, and `Save`.

### Waveform rendering

1px bars with 1px gaps, mirrored about a horizontal centre line. Peaks are
computed in the renderer from the decoded preview audio (see below), so no
separate analysis pass is needed.

### Mute interaction

Clicking a lane's icon toggles mute for that track. A muted lane draws an X over
the icon and drops the whole row to roughly 35% opacity, waveform included. The
change is audible immediately.

There is no solo button. With three lanes, solo is muting the other two.

## Live mixing

### Why it needs native help

Chromium's `<video>` element decodes only the first audio track of an MP4. The
codebase already documents this at `clip_exporter.cpp` — it is the reason the
share export mixes down to a single track. `decodeAudioData` shares the same
demuxer and has the same limit, so the renderer cannot reach `mic` or `other` on
its own.

### The decode call

One new native function serves both live preview and waveforms:

```
decodeClipAudio(path, { sampleRate }) -> {
  tracks: [ { id: "game" | "mic" | "other", samples: Float32Array } ],
  sampleRate: number
}
```

It is a variation on the decode loop that already exists in the exporter, which
reads each audio stream as `MFAudioFormat_Float` and sums it into one buffer.
Here the tracks stay separate and are not summed.

Preview audio is decoded as **mono at 22050 Hz**. That is enough for judging a
mix and for drawing waveforms, and it keeps a 5-minute clip near 26 MB across
all three tracks instead of roughly 345 MB at full stereo rate. Export continues
to decode at full quality; this rate applies to preview only.

### The graph

Each track becomes an `AudioBuffer` feeding an `AudioBufferSourceNode` into its
own `GainNode`, all summed into the destination. A lane's gain slider writes
directly to its `GainNode.gain`; mute sets it to zero. No re-decode, no re-render.

The video element is the clock and stays muted, or the `game` track would play
twice. On play, the three source nodes start together at the video's current
offset. On pause, seek, or handle drag, the nodes are stopped and recreated at
the new offset — `AudioBufferSourceNode` is single-use by design.

## Frame-exact trim

### What already works

The tail is already frame-exact. `clip_trimmer.cpp` walks samples and stops on
`time >= requestedEnd`. Both encoders enable `AVLowLatencyMode`, which disables
B-frames, so no frame references a later frame and the stream can be cut at any
sample without breaking decode.

Only the head snaps. The trimmer seeks and then hard-fails unless it lands on a
keyframe, and reports the drift back to the UI as `actualStartSeconds`. With a
GOP of `fps * 2`, that drift is up to 2 seconds.

### Smart render

To make the head exact:

1. Seek to the keyframe preceding the in-point, as today.
2. Decode from that keyframe up to the in-point.
3. Re-encode that fragment, starting on a fresh IDR at the in-point, using the
   source's resolution, frame rate and profile.
4. Stream-copy every sample from the next keyframe onward, unchanged.
5. Concatenate the two into one track.

Only the head fragment is re-encoded — at most one GOP, about 2 seconds. The
rest of the clip is copied bit for bit.

The delicate part is parameter sets: the re-encoded head and the copied body
must agree on SPS/PPS, or the muxer writes an `avcC` the decoder rejects. The
head encoder is configured from the source's own media type to keep them
aligned, and the result is verified by decoding the first frames of the output.

If the in-point already sits on a keyframe, steps 2 through 4 are skipped
entirely and the save stays a pure remux.

### Audio and gain

Gains are not free. If every gain is unity, all three audio tracks are copied
untouched and the clip keeps its three-track structure. If any gain differs, the
tracks are decoded, scaled, summed and re-encoded as a single AAC track — the
same mixdown the share export already performs, and for the same reason: every
upload path plays only the first track.

This is a deliberate trade. Muting Discord means the saved clip no longer has
separate tracks. The footer's `lossless` badge goes dark whenever it applies, so
the cost is visible before the user commits.

## Saturation

A creative control, not a correction. Flash records BT.709 limited and tags
every media type to say so, which is what makes clips look right in the first
place; the slider exists to push a look past correct, not to rescue a broken
one.

Preview applies it as a CSS `filter: saturate()` on the video element — free,
instant, no decode involved.

On save it is a real pixel operation, so it carries the same cost as gain: any
value other than 100 forces a full video re-encode and the `lossless` badge goes
dark. This is a heavier trade than the audio one — audio re-encoding costs
seconds, video re-encoding costs the whole clip — so the footer states which of
the two triggered it rather than just dimming the badge.

At 100 the slider contributes nothing to the save path and is skipped entirely.

## Saving

Save writes a new file and leaves the original in place.

## Error handling

- A clip whose audio cannot be decoded still opens; affected lanes render empty
  and disabled rather than blocking the editor.
- Smart render failures fall back to the current keyframe-snapped remux, with
  the actual in-point reported in the UI instead of silently applied.
- A clip with no audio tracks opens with the mixer hidden.
- Existing trimmer guards stay: same-path rejection, missing input, non-H.264
  input, multiple video streams.

## Testing

Native, following the existing standalone `assert` pattern under `test/`:

- Gain application: unity gain leaves samples bit-identical; zero gain produces
  silence; summing three scaled tracks clips to [-1, 1].
- Smart-render planning: given a keyframe list and an in-point, the planner
  returns the right head fragment and copy start, including the in-point-is-a-
  keyframe case where the head is empty.
- Preview decode: track count and ordering match `kAudioTrackOrder`, and the
  returned sample count matches the clip duration within one frame.

Renderer:

- Peak computation returns the expected bucket count for a known buffer length.
- Timecode formatting and in/out clamping (out never precedes in; neither
  escapes the clip).

## Out of scope

Multi-clip timelines, transitions, text, subtitles, music, VFX, filters, speed
baked into exports, and detached audio.

Colour correction beyond the saturation slider — curves, white balance, LUTs —
is out. The slider is deliberately the only picture control: it is one value,
it has an obvious neutral position, and it cannot hide a capture-side defect the
way a full grading panel could.
