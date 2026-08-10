// Self-check for the clip editor maths. Run with:
//   node --experimental-strip-types src/shared/editor.test.ts
import { strict as assert } from 'node:assert'
import { formatTimecode, clampRange } from './editor.ts'

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

console.log('clip editor self-check passed')
