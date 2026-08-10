// Self-check for the clip editor maths. Run with:
//   node --experimental-strip-types src/shared/editor.test.ts
import { strict as assert } from 'node:assert'
import { formatTimecode, clampRange, nearestKeyframe } from './editor.ts'

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

console.log('clip editor self-check passed')
