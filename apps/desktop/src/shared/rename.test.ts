// Self-check for clip filename validation and collision handling. Run with:
//   node --experimental-strip-types src/shared/rename.test.ts
import { strict as assert } from 'node:assert'
import { resolveClipFilename, validateClipName } from './rename.ts'

assert.match(validateClipName('bad/name') ?? '', /cannot contain/)
assert.match(validateClipName('   ') ?? '', /Enter a name/)
assert.match(validateClipName('CON') ?? '', /reserved/)
assert.match(validateClipName('...') ?? '', /only dots/)

assert.equal(resolveClipFilename('Victory', '.mp4', ['Victory.mp4']), 'Victory (2).mp4')
assert.equal(resolveClipFilename('Victory', '.mp4', ['Victory.mp4.json']), 'Victory (2).mp4')
assert.equal(resolveClipFilename('Victory', '.png', ['Victory.mp4.json']), 'Victory.png')
assert.equal(
  resolveClipFilename('Victory', '.mp4', ['Victory.mp4', 'Victory (2).mp4']),
  'Victory (3).mp4',
)

console.log('clip rename self-check passed')
