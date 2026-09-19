// Self-check for the clip editor maths. Run with:
//   node --experimental-strip-types src/shared/editor.test.ts
import { strict as assert } from 'node:assert'
import { formatTimecode, clampRange, nearestKeyframe, deriveSaveMode, matchesQuery } from './editor.ts'
import { reducePeaks, clipUrl } from './editor.ts'

const searchableClips = [
  { id: 'title', title: 'Final Escape', game: 'Portal 2' },
  { id: 'game', title: 'Close Call', game: 'Final Fantasy XIV' },
  { id: 'miss', title: 'Victory', game: 'Hades' },
]
assert.deepEqual(searchableClips.filter(clip => matchesQuery(clip, 'nAl')).map(clip => clip.id), ['title', 'game'])

// An unrenamed clip is searchable by what the card actually shows.
const autoNamed = [{ id: 'auto', title: '2026 09 13 02 45 12', game: 'Rocket League' }]
assert.deepEqual(autoNamed.filter(clip => matchesQuery(clip, 'sep')).map(clip => clip.id), ['auto'])
assert.deepEqual(autoNamed.filter(clip => matchesQuery(clip, '2:45')).map(clip => clip.id), ['auto'])
assert.deepEqual(autoNamed.filter(clip => matchesQuery(clip, '2026 09 13')).map(clip => clip.id), ['auto'])
assert.deepEqual(autoNamed.filter(clip => matchesQuery(clip, 'october')).map(clip => clip.id), [])

assert.equal(formatTimecode(0), '0:00.0')
assert.equal(formatTimecode(4.24), '0:04.2')
assert.equal(formatTimecode(65.98), '1:05.9')
assert.equal(formatTimecode(-3), '0:00.0')
assert.equal(formatTimecode(NaN), '0:00.0')

// Ordinary ranges pass through untouched.
assert.deepEqual(clampRange(2, 8, 30), { inSec: 2, outSec: 8 })

// Neither handle escapes the clip.
assert.deepEqual(clampRange(-5, 8, 30), { inSec: 0, outSec: 8 })
assert.deepEqual(clampRange(2, 99, 30), { inSec: 2, outSec: 30 })

// Dragging the in handle past the out handle pushes the other along rather
// than inverting the range or collapsing it to nothing. A zero-length range is
// exactly what the native trimmer refuses.
const crossed = clampRange(9, 8, 30)
assert.ok(crossed.outSec > crossed.inSec, `crossed collapsed to ${JSON.stringify(crossed)}`)

// Crossing at the very end has nowhere forward to push, so it pushes back.
const atEnd = clampRange(30, 30, 30)
assert.ok(atEnd.outSec > atEnd.inSec, `end collapsed to ${JSON.stringify(atEnd)}`)
assert.ok(atEnd.outSec <= 30)

// A zero-length clip must not produce a negative or NaN range.
const empty = clampRange(0, 0, 0)
assert.ok(Number.isFinite(empty.inSec) && Number.isFinite(empty.outSec))
assert.ok(empty.outSec >= empty.inSec)

// Keyframe snapping. Real keyframes land on values like 3.72865, so the match
// has to carry a tolerance; an exact one never fires.
const keys = [0, 3.72865, 7.45205, 11.1854]
assert.equal(nearestKeyframe(keys, 3.75, 0.15), 3.72865)
assert.equal(nearestKeyframe(keys, 3.7, 0.15), 3.72865)
assert.equal(nearestKeyframe(keys, 5.5, 0.15), null)      // genuinely mid-GOP
assert.equal(nearestKeyframe(keys, 11.2, 0.15), 11.1854)
assert.equal(nearestKeyframe([], 4, 0.15), null)
assert.equal(nearestKeyframe(keys, 0, 0), 0)              // exact hit needs no tolerance

// With two keyframes inside the window it takes the closer one, not the first.
assert.equal(nearestKeyframe([3.6, 3.9], 3.85, 0.5), 3.9)

// One bucket per sample is the identity on magnitude.
const four = reducePeaks(new Float32Array([0, 0.5, -1, 0.25]), 4)
assert.equal(four.length, 4)
assert.equal(four[2], 1)                       // magnitude, not signed value

// Fewer buckets than samples keeps the peak of each span, not the mean —
// a single loud frame must stay visible after reduction.
const two = reducePeaks(new Float32Array([0, 0.1, 0.9, 0.2]), 2)
assert.equal(two.length, 2)
assert.equal(two[1], Math.fround(0.9))

// More buckets than samples must not produce NaN or read off the end.
const wide = reducePeaks(new Float32Array([1]), 4)
assert.equal(wide.length, 4)
assert.ok(wide.every(Number.isFinite))

// Degenerate inputs return an empty result rather than throwing.
assert.equal(reducePeaks(new Float32Array([]), 8).length, 8)
assert.equal(reducePeaks(new Float32Array([1, 2]), 0).length, 0)

// Nothing changed but the cut, and the cut is on a keyframe: pure remux.
assert.deepEqual(deriveSaveMode(true, [1, 1, 1], 100), { lossless: true, reason: 'none' })

// An off-keyframe in-point costs a head re-encode only.
assert.deepEqual(deriveSaveMode(false, [1, 1, 1], 100), { lossless: false, reason: 'trim' })

// A gain change re-encodes audio - cheap, seconds.
assert.deepEqual(deriveSaveMode(true, [1, 0, 1], 100), { lossless: false, reason: 'audio' })

// Saturation re-encodes every frame, and must win the reported reason so the
// user is told the worse cost rather than the milder one.
assert.deepEqual(deriveSaveMode(true, [1, 1, 1], 120), { lossless: false, reason: 'video' })
assert.deepEqual(deriveSaveMode(false, [1, 0, 1], 80), { lossless: false, reason: 'video' })

// No tracks at all is still lossless when nothing else changed.
assert.deepEqual(deriveSaveMode(true, [], 100), { lossless: true, reason: 'none' })

// clipUrl has to survive the punctuation Windows allows in a filename. '#' is
// the one that matters: encodeURI leaves it alone, so "round#2.mp4" was
// requested as "round" with the rest as a fragment, and played as missing.
assert.equal(clipUrl('C:\\Clips\\Halo\\round#2.mp4'),
  'flash-clip://local/C%3A/Clips/Halo/round%232.mp4')
assert.equal(clipUrl('C:\\Clips\\a b & c?.mp4'),
  'flash-clip://local/C%3A/Clips/a%20b%20%26%20c%3F.mp4')
// Every segment survives a decode round trip, which is what the protocol
// handler does before it touches the disk.
for (const path of ['C:\\Clips\\Halo\\round#2.mp4', 'C:\\Clips\\a b & c?.mp4', 'C:\\Clips\\100% win.mp4']) {
  const decoded = decodeURIComponent(new URL(clipUrl(path)).pathname)
    .replace(/^\//, '').replace(/\//g, '\\')
  assert.equal(decoded, path)
}

console.log('clip editor self-check passed')
