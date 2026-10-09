// Self-check for settings sanitising. Run with:
//   node --experimental-strip-types src/shared/sanitise.test.ts
import { strict as assert } from 'node:assert'
import { sanitise, QUALITY_OPTIONS } from './sanitise.ts'

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

const settings = {
  quality: '1080p 60fps', bufferLength: 30, shortClipSeconds: 15,
  autoDeleteDays: 0, theme: 'blood', overlayPosition: 'top-left',
  hotkey: 'F8', hotkeyShort: 'Shift+F8', screenshotHotkey: 'F9', perGame: {},
}
for (const quality of QUALITY_OPTIONS) assert.equal(sanitise(settings, { quality }).quality, quality)
assert.deepEqual(sanitise(settings, { quality: '8K 999fps' }), {})
for (const bufferLength of [10, 15, 300]) assert.equal(sanitise(settings, { bufferLength }).bufferLength, bufferLength)
for (const bufferLength of [0, 9, 11, 301, 10.5, NaN, Infinity, '30']) {
  assert.deepEqual(sanitise(settings, { bufferLength }), {})
}
for (const shortClipSeconds of [5, 30]) assert.equal(sanitise(settings, { shortClipSeconds }).shortClipSeconds, shortClipSeconds)
for (const shortClipSeconds of [4, 31, NaN]) assert.deepEqual(sanitise(settings, { shortClipSeconds }), {})
assert.deepEqual(sanitise(settings, { bufferLength: 10, shortClipSeconds: 15 }), { bufferLength: 10 })
assert.deepEqual(sanitise(settings, { bufferLength: 60, shortClipSeconds: 60 }), { bufferLength: 60, shortClipSeconds: 60 })
assert.deepEqual(sanitise({ ...settings, bufferLength: 60 }, { shortClipSeconds: 45 }), { shortClipSeconds: 45 })
for (const autoDeleteDays of [0, 7, 30, 90]) assert.equal(sanitise(settings, { autoDeleteDays }).autoDeleteDays, autoDeleteDays)
for (const autoDeleteDays of [-1, 1, 365]) assert.deepEqual(sanitise(settings, { autoDeleteDays }), {})
for (const theme of ['blood', 'ultraviolet', 'cobalt', 'fuchsia', 'indigo', 'bone']) {
  assert.equal(sanitise(settings, { theme }).theme, theme)
}
for (const theme of ['unknown', 'toString', '__proto__']) assert.deepEqual(sanitise(settings, { theme }), {})
for (const overlayPosition of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
  assert.equal(sanitise(settings, { overlayPosition }).overlayPosition, overlayPosition)
}
assert.deepEqual(sanitise(settings, { overlayPosition: 'center' }), {})
for (const key of ['hotkey', 'hotkeyShort', 'screenshotHotkey']) {
  assert.deepEqual(sanitise(settings, { [key]: 'Ctrl+F9' }), { [key]: 'Ctrl+F9' })
  for (const value of ['', '  ', null]) assert.deepEqual(sanitise(settings, { [key]: value }), {})
}
assert.deepEqual(sanitise(settings, { perGame: {
  good: { quality: '4K 60fps', bufferLength: 300, extra: true },
  mixed: { quality: 'invalid', bufferLength: 15 },
  bad: { quality: 123, bufferLength: 11 }, null: null, array: [],
} }), { perGame: {
  good: { quality: '4K 60fps', bufferLength: 300 }, mixed: { bufferLength: 15 }, bad: {}, null: {}, array: {},
} })
console.log('settings sanitise self-check passed')

const collections = { displayId: 0, learnedGames: {}, ignoredGames: [] }
for (const displayId of [-1, 0.5, 2 ** 32, NaN, Infinity, '1', null]) {
  assert.deepEqual(sanitise(collections, { displayId }), {})
}
assert.equal(sanitise(collections, { displayId: 2 }).displayId, 2)
assert.deepEqual(sanitise(collections, {
  learnedGames: { 'game.exe': '  Game  ', broken: 123, blank: '', nested: {} },
  ignoredGames: ['ignore.exe', null, {}, 42, '', 'ignore.exe'],
}), { learnedGames: { 'game.exe': 'Game' }, ignoredGames: ['ignore.exe'] })
console.log('PASS: display IDs and learned/ignored collection contents validated')
