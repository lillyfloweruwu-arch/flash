// Self-check for the custom voice phrase syllable warning. Run with:
//   node --experimental-strip-types src/shared/syllables.test.ts
import { strict as assert } from 'node:assert'
import { countSyllables } from './syllables.ts'

assert.equal(countSyllables(''), 0)
assert.equal(countSyllables('flash'), 1)
assert.equal(countSyllables('flash clip'), 2)
assert.equal(countSyllables('flash clip that'), 3)

// Adjacent vowels form one group, and matching is case insensitive.
assert.equal(countSyllables('QUEUE AUDIO'), 3)
// Y participates in the approximation so phrases such as "my clip" do not
// appear to have no vowel sound in their first word.
assert.equal(countSyllables('my clip'), 2)

console.log('syllable count self-check passed')
