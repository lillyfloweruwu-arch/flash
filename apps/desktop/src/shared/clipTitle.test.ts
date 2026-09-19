// Self-check for clip titles. Run with:
//   node --experimental-strip-types src/shared/clipTitle.test.ts
import { strict as assert } from 'node:assert'
import { clipDisplayTitle } from './clipTitle.ts'

const thisYear = new Date(2026, 8, 19)

// The shape scanClips produces from an auto-saved filename.
assert.equal(clipDisplayTitle('2026 09 13 02 45 12', thisYear), '13 Sep · 2:45:12 AM')
assert.equal(clipDisplayTitle('2026 09 13 14 05 09', thisYear), '13 Sep · 2:05:09 PM')

// Midnight and noon are the two the 12-hour clock gets wrong when written naively.
assert.equal(clipDisplayTitle('2026 01 01 00 00 00', thisYear), '1 Jan · 12:00:00 AM')
assert.equal(clipDisplayTitle('2026 01 01 12 00 00', thisYear), '1 Jan · 12:00:00 PM')
assert.equal(clipDisplayTitle('2026 01 01 12 30 00', thisYear), '1 Jan · 12:30:00 PM')
assert.equal(clipDisplayTitle('2026 01 01 23 59 59', thisYear), '1 Jan · 11:59:59 PM')

// A year that is not this one earns the year; this one does not.
assert.equal(clipDisplayTitle('2025 12 31 21 15 00', thisYear), '31 Dec 2025 · 9:15:00 PM')

// Anything the user named is theirs, untouched.
assert.equal(clipDisplayTitle('Insane flick reset', thisYear), 'Insane flick reset')
assert.equal(clipDisplayTitle('2026 09 13', thisYear), '2026 09 13')
assert.equal(clipDisplayTitle('2026 09 13 02 45 12 - trim', thisYear), '2026 09 13 02 45 12 - trim')
assert.equal(clipDisplayTitle('', thisYear), '')

// Numbers in the right shape but not a real date are left alone rather than
// rendered as a month that does not exist.
assert.equal(clipDisplayTitle('2026 13 01 10 00 00', thisYear), '2026 13 01 10 00 00')
assert.equal(clipDisplayTitle('2026 09 13 24 00 00', thisYear), '2026 09 13 24 00 00')
assert.equal(clipDisplayTitle('2026 09 13 10 60 00', thisYear), '2026 09 13 10 60 00')

console.log('clip title self-check passed')
