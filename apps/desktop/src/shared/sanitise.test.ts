// Self-check for settings sanitising. Run with:
//   node --experimental-strip-types src/shared/sanitise.test.ts
import { strict as assert } from 'node:assert'
import { sanitise } from './sanitise.ts'

const defaults = {
  name: 'default-name',
  age: 25,
  active: true,
  tags: ['a', 'b'],
  metadata: { key: 'value' }
}

// a string kept
assert.deepEqual(sanitise(defaults, { name: 'new-name' }), { name: 'new-name' })

// a number kept
assert.deepEqual(sanitise(defaults, { age: 30 }), { age: 30 })

// a boolean kept
assert.deepEqual(sanitise(defaults, { active: false }), { active: false })

// wrong-typed value dropped
assert.deepEqual(sanitise(defaults, { name: 123 }), {})

// null dropped for a string default
assert.deepEqual(sanitise(defaults, { name: null }), {})

// unknown key dropped
assert.deepEqual(sanitise(defaults, { unknown: 'value' }), {})

// NaN dropped
assert.deepEqual(sanitise(defaults, { age: NaN }), {})

// Infinity dropped
assert.deepEqual(sanitise(defaults, { age: Infinity }), {})

// -Infinity dropped
assert.deepEqual(sanitise(defaults, { age: -Infinity }), {})

// array kept for an array default
assert.deepEqual(sanitise(defaults, { tags: ['c', 'd'] }), { tags: ['c', 'd'] })

// non-array dropped for an array default
assert.deepEqual(sanitise(defaults, { tags: 'not-array' }), {})

// object kept for an object default
assert.deepEqual(sanitise(defaults, { metadata: { key: 'new-value' } }), { metadata: { key: 'new-value' } })

// array dropped for an object default
assert.deepEqual(sanitise(defaults, { metadata: [1, 2, 3] }), {})

// sanitise(defaults, null) returns {}
assert.deepEqual(sanitise(defaults, null), {})

// sanitise(defaults, 'text') returns {}
assert.deepEqual(sanitise(defaults, 'text'), {})

// sanitise(defaults, [1, 2]) returns {}
assert.deepEqual(sanitise(defaults, [1, 2]), {})

// defaults is unchanged after a call
const defaultsCopy = JSON.parse(JSON.stringify(defaults))
sanitise(defaults, { name: 'changed' })
assert.deepEqual(defaults, defaultsCopy)

console.log('settings sanitise self-check passed')
