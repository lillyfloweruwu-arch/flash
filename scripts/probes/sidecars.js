// Exercises the same filesystem helpers used by the library scan and star handler.
// Run with node --experimental-strip-types scripts/probes/sidecars.js.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')

;(async () => {
  const { migrateSidecars, readSidecar, writeSidecar, reserveOutput } =
    await import('../../apps/desktop/src/shared/clipFiles.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-sidecars-'))
  const file = name => path.join(dir, name)
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args[0])
  try {
    fs.writeFileSync(file('solo.mp4'), '')
    fs.writeFileSync(file('solo.json'), JSON.stringify({ game: 'Solo', starred: true }))
    assert.equal(migrateSidecars(dir).size, 0)
    assert.equal(fs.existsSync(file('solo.json')), false)
    assert.equal(readSidecar(file('solo.mp4')).starred, true)
    console.log('PASS: single-media legacy sidecar migrated')

    fs.writeFileSync(file('solo.mp4.png'), '')
    migrateSidecars(dir)
    assert.equal(readSidecar(file('solo.mp4')).starred, true)
    assert.equal(readSidecar(file('solo.mp4.png')), null)

    for (const extension of ['mp4', 'png']) fs.writeFileSync(file(`round.${extension}`), '')
    fs.writeFileSync(file('round.json'), JSON.stringify({ duration: 12, game: 'Round', starred: true }))
    writeSidecar(file('round.mp4'), { starred: false })
    assert.equal(migrateSidecars(dir).size, 0)
    assert.equal(readSidecar(file('round.mp4')).starred, true)
    assert.equal(readSidecar(file('round.png')).starred, true)
    assert.equal(fs.existsSync(file('round.json')), false)
    writeSidecar(file('round.mp4'), { starred: false })
    assert.equal(readSidecar(file('round.png')).starred, true)
    fs.unlinkSync(file('round.mp4'))
    fs.unlinkSync(file('round.mp4.json'))
    assert.equal(readSidecar(file('round.png')).starred, true)
    console.log('PASS: shared legacy star preserved; unstar/delete are independent')

    fs.writeFileSync(file('broken.mp4'), '')
    fs.writeFileSync(file('broken.mp4.json'), '{')
    assert.equal(readSidecar(file('broken.mp4')).starred, true)
    fs.writeFileSync(file('legacy.png'), '')
    fs.writeFileSync(file('legacy.json'), 'null')
    migrateSidecars(dir)
    assert.equal(fs.existsSync(file('legacy.json')), false)
    assert.equal(readSidecar(file('legacy.png')).starred, true)
    fs.writeFileSync(file('conflict.mp4'), '')
    fs.writeFileSync(file('conflict.json'), JSON.stringify({ starred: true }))
    fs.writeFileSync(file('conflict.mp4.json'), '{')
    assert.equal(migrateSidecars(dir).has(file('conflict.mp4')), true)
    assert.equal(fs.existsSync(file('conflict.json')), true)
    fs.mkdirSync(file('unreadable.png.json'))
    assert.equal(readSidecar(file('unreadable.png')).starred, true)
    assert.throws(() => writeSidecar(file('unreadable.png'), { starred: false }))
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false)
    assert.equal(warnings.length >= 3, true)
    console.log('PASS: corrupt/unreadable metadata protected and logged; failed atomic write cleaned up')

    const first = reserveOutput(file('share.mp4'))
    const second = reserveOutput(file('share.mp4'))
    assert.equal(path.basename(second.path), 'share (2).mp4')
    fs.writeFileSync(first.path, 'first')
    first.release()
    const third = reserveOutput(file('share.mp4'))
    assert.equal(path.basename(third.path), 'share (3).mp4')
    second.release()
    third.release()
    console.log('PASS: existing and in-flight outputs reserve distinct names')
  } finally {
    console.warn = warn
    fs.rmSync(dir, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
