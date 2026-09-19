// Self-check for clips-folder containment. Run with:
//   node --experimental-strip-types src/shared/clipsRoot.test.ts
import { strict as assert } from 'node:assert'
import { isInsideRoot } from './clipsRoot.ts'

// Ordinary containment, including the root itself.
assert.equal(isInsideRoot('C:\\Clips', 'C:\\Clips\\game\\a.mp4'), true)
assert.equal(isInsideRoot('C:\\Clips', 'C:\\Clips'), true)
assert.equal(isInsideRoot('C:\\Clips\\', 'C:\\Clips\\a.mp4'), true)

// Windows paths are case-insensitive and accept either separator. A real clip
// must not be refused just because the settings file spells the drive letter
// differently from the one the scan produced.
assert.equal(isInsideRoot('C:\\Clips', 'c:/clips/GAME/a.mp4'), true)
assert.equal(isInsideRoot('C:/Clips', 'C:\\\\Clips\\\\a.mp4'), true)

// The three things a plain startsWith gets wrong.
assert.equal(isInsideRoot('C:\\Clips', 'C:\\Clips-old\\a.mp4'), false)
assert.equal(isInsideRoot('C:\\Clips', 'C:\\Clipsx'), false)
assert.equal(isInsideRoot('C:\\Clips', 'C:\\Clips\\..\\Other\\a.mp4'), false)
assert.equal(isInsideRoot('C:\\Clips', 'C:\\Clips\\..\\..\\Windows\\notepad.exe'), false)

// A traversal that stays inside is still inside.
assert.equal(isInsideRoot('C:\\Clips', 'C:\\Clips\\game\\..\\other\\a.mp4'), true)

// Different drive, shorter path, and missing arguments.
assert.equal(isInsideRoot('C:\\Clips', 'D:\\Clips\\a.mp4'), false)
assert.equal(isInsideRoot('C:\\Clips\\game', 'C:\\Clips'), false)
assert.equal(isInsideRoot('', 'C:\\Clips\\a.mp4'), false)
assert.equal(isInsideRoot('C:\\Clips', ''), false)
assert.equal(isInsideRoot(undefined as unknown as string, 'C:\\Clips\\a.mp4'), false)
assert.equal(isInsideRoot('C:\\Clips', null as unknown as string), false)

console.log('clips root self-check passed')
