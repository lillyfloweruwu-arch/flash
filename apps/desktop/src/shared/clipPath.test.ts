// Self-check for clip and screenshot naming. Run with:
//   node --experimental-strip-types src/shared/clipPath.test.ts
import { strict as assert } from 'node:assert'
import { clipTimestamp, gameFolderName, numberedName, firstFreeName, sidecarPath, isFlashClip, isFlashClipName } from './clipPath.ts'

// Local time, zero padded, in the exact shape the native writer produces.
assert.equal(clipTimestamp(new Date(2026, 7, 13, 9, 5, 3)), '2026-08-13_09-05-03')
assert.equal(clipTimestamp(new Date(2026, 11, 1, 23, 59, 59)), '2026-12-01_23-59-59')

assert.equal(gameFolderName('Rocket League'), 'Rocket League')
assert.equal(gameFolderName(''), 'Unknown')
assert.equal(gameFolderName('   '), 'Unknown')
// Every character Windows refuses, each becoming one underscore rather than
// vanishing - otherwise "A:B" and "AB" would land in the same folder.
assert.equal(gameFolderName('A<B>C:D"E/F\\G|H?I*J'), 'A_B_C_D_E_F_G_H_I_J')

// The first file is bare; only the second onward is numbered.
assert.equal(numberedName('2026-08-13_09-05-03', 1, '.png'), '2026-08-13_09-05-03.png')
assert.equal(numberedName('2026-08-13_09-05-03', 2, '.png'), '2026-08-13_09-05-03_2.png')

assert.equal(firstFreeName('shot', '.png', []), 'shot.png')
assert.equal(firstFreeName('shot', '.png', ['shot.png']), 'shot_2.png')
assert.equal(firstFreeName('shot', '.png', ['shot.png', 'shot_2.png']), 'shot_3.png')
// Windows paths are case insensitive, so a differently cased existing file is
// still a collision. Getting this wrong overwrites a real screenshot.
assert.equal(firstFreeName('shot', '.png', ['SHOT.PNG']), 'shot_2.png')
assert.equal(firstFreeName('shot', '.png', ['shot.png.json']), 'shot_2.png')
assert.equal(sidecarPath('round.mp4'), 'round.mp4.json')
assert.equal(sidecarPath('round.png'), 'round.png.json')
// A gap left by a deleted file is reused: the counter returns the first free
// name rather than the highest plus one, which is what the native writer's
// loop does too.
assert.equal(firstFreeName('shot', '.png', ['shot.png', 'shot_3.png']), 'shot_2.png')

// Only Flash-shaped names or files carrying a Flash sidecar may be pruned.
assert.equal(isFlashClipName('2026-11-11_19-36-34.mp4'), true)
assert.equal(isFlashClipName('2026-11-11_19-36-34.png'), true)
assert.equal(isFlashClipName('2026-11-11_19-36-34_2.mp4'), true)
assert.equal(isFlashClipName('holiday.mp4'), false)
assert.equal(isFlashClipName('2026-11-11 19.36.34.mp4'), false)
assert.equal(isFlashClip('holiday.mp4', false), false)
assert.equal(isFlashClip('holiday.mp4', true), true)
assert.equal(isFlashClip('2026-11-11_19-36-34.mp4', false), true)

console.log('clip path self-check passed')
