// Self-check for hotkey capture. Run with:
//   node --experimental-strip-types src/shared/accelerator.test.ts
import { strict as assert } from 'node:assert'
import { toAccelerator } from './accelerator.ts'

const press = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  toAccelerator({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods } as any)

// Plain keys
assert.equal(press('F8'), 'F8')
assert.equal(press('KeyG'), 'G')
assert.equal(press('Digit4'), '4')
assert.equal(press('Numpad7'), 'num7')
assert.equal(press('Backquote'), '`')
assert.equal(press('ArrowUp'), 'Up')

// Modifier order is fixed so the same chord always stringifies identically.
assert.equal(press('KeyC', { ctrlKey: true, shiftKey: true }), 'Control+Shift+C')
assert.equal(press('F9', { altKey: true }), 'Alt+F9')
assert.equal(press('KeyX', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }),
  'Control+Alt+Shift+Super+X')

// Bare modifiers are not a hotkey — the picker must keep listening.
assert.equal(press('ShiftLeft', { shiftKey: true }), null)
assert.equal(press('ControlLeft', { ctrlKey: true }), null)
assert.equal(press('AltRight', { altKey: true }), null)
assert.equal(press('MetaLeft', { metaKey: true }), null)

// F25 does not exist; anything Electron would reject must return null rather
// than producing an accelerator that silently fails to register.
assert.equal(press('F25'), null)
assert.equal(press('CapsLock'), null)
assert.equal(press('Unidentified'), null)

console.log('accelerator: ok')
