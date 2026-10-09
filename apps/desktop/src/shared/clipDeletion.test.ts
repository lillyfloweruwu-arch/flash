import { strict as assert } from 'node:assert'
import { createClipDeletion } from './clipDeletion.ts'

let starred = false, attempts = 0, removed = 0
const deletion = createClipDeletion({
  allowed: (_path, intent) => intent === 'manual' || !starred,
  unlink: () => { attempts++; if (attempts === 1) throw { code: 'EBUSY' }; removed++ },
  cleanup: () => {},
  wait: async () => { starred = true },
})
assert.equal(await deletion.remove('fixture.mp4', 'prune'), false)
assert.equal(removed, 0)
assert.equal(await deletion.remove('fixture.mp4', 'manual'), true)
assert.equal(removed, 1)

let retries = 0
const exhausted = createClipDeletion({ allowed: () => true, unlink: () => { retries++; throw { code: 'EPERM' } }, cleanup: () => {}, wait: async () => {} })
assert.equal(await exhausted.remove('locked.mp4', 'manual'), false)
assert.equal(retries, 11)

let unlinks = 0
const mixed = createClipDeletion({ allowed: path => path !== 'protected.mp4', unlink: () => { unlinks++ }, cleanup: () => {} })
const first = mixed.remove('one.mp4', 'manual')
assert.equal(mixed.busy('one.mp4'), true)
assert.deepEqual(await Promise.all([first, mixed.remove('one.mp4', 'prune'), mixed.remove('protected.mp4', 'manual')]), [true, true, false])
assert.equal(unlinks, 1)
assert.equal(mixed.busy('one.mp4'), false)
console.log('PASS: star during retry survives; manual intent, 11 exhausted attempts, serialized duplicate and mixed results')
