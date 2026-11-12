// Self-check for feedback validation and the endpoint. Run with:
//   node --experimental-strip-types src/shared/feedback.test.ts
import { strict as assert } from 'node:assert'
import {
  FEEDBACK_ENDPOINT, FEEDBACK_MAX_LENGTH, FEEDBACK_MIN_LENGTH, validateFeedback,
} from './feedback.ts'

assert.equal(FEEDBACK_ENDPOINT, 'https://lubuntuserver.tail857ab5.ts.net:10000/flash-feedback')
assert.equal(FEEDBACK_MIN_LENGTH, 3)
assert.equal(FEEDBACK_MAX_LENGTH, 2000)

// Anything that is not text is refused.
assert.equal(validateFeedback(null), 'Message must be text.')
assert.equal(validateFeedback(42), 'Message must be text.')

// The bounds are measured after trimming.
assert.equal(validateFeedback('hi'), 'Message is too short.')
assert.equal(validateFeedback('  hi  '), 'Message is too short.')
assert.equal(validateFeedback('abc'), null)
assert.equal(validateFeedback('  abc  '), null)
assert.equal(validateFeedback('a'.repeat(FEEDBACK_MAX_LENGTH)), null)
assert.equal(validateFeedback('a'.repeat(FEEDBACK_MAX_LENGTH + 1)), 'Message is too long.')
assert.equal(validateFeedback('a'.repeat(FEEDBACK_MAX_LENGTH - 2) + '   '), null)

console.log('feedback self-check passed')
