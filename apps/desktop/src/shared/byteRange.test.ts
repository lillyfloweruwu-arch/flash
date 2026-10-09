import { strict as assert } from 'node:assert'
import { byteRange } from './byteRange.ts'

const fixture = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
for (const [header, status, start, end] of [
  [null, 200, 0, 999], ['bytes=0-99', 206, 0, 99], ['bytes=900-', 206, 900, 999],
  ['bytes=-100', 206, 900, 999], ['bytes=-2000', 206, 0, 999], ['bytes=990-2000', 206, 990, 999],
] as const) {
  const range = byteRange(header, fixture.length)
  assert.deepEqual(range, { status, start, end })
  assert.deepEqual(fixture.subarray(range.start, range.end + 1), fixture.subarray(start, end + 1))
}
for (const header of ['bytes=-', 'bytes=-0', 'bytes=1000-', 'bytes=9-2', 'bytes=1-2,4-5', 'bytes=a-2', 'no bytes=0-1', 'bytes=9007199254740992-', 'items=0-2']) {
  assert.equal(byteRange(header, 1000).status, 416, header)
}
assert.deepEqual(byteRange(null, 0), { status: 200, start: 0, end: -1 })
assert.equal(byteRange('bytes=0-', 0).status, 416)
console.log('PASS: full, open, suffix, oversized, malformed and empty byte ranges')
