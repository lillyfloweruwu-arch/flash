// Self-check for per-game capture setting resolution. Run with:
//   node --experimental-strip-types src/shared/perGame.test.ts
import { strict as assert } from 'node:assert'
import { resolveGameSettings } from './perGame.ts'

const globals = { quality: '1080p 60fps', bufferLength: 30 }

assert.deepEqual(resolveGameSettings({}, 'Hades', globals), globals)
assert.deepEqual(
  resolveGameSettings({ Hades: { quality: '1440p 60fps' } }, 'Hades', globals),
  { quality: '1440p 60fps', bufferLength: 30 },
)
assert.deepEqual(
  resolveGameSettings({ Hades: { bufferLength: 60 } }, 'Portal 2', globals),
  globals,
)

console.log('per-game settings self-check passed')
