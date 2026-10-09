// Records a short source, changes games during a save, then exports twice.
// Run with node --experimental-strip-types scripts/probes/export-and-game.js.
const safe = process.argv.includes('--safe')
const addonPath = require('node:path').join(__dirname, '../../packages/flash-capture/build', process.platform === 'win32' ? 'Release' : '', 'flash_capture.node')
if (safe && !require('node:fs').existsSync(addonPath)) {
  console.log('SKIP: safe native export checks require a built addon')
  process.exit(0)
}
const addon = require(addonPath)
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createHash } = require('node:crypto')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

;(async () => {
  const { reserveOutput, writeSidecar, readSidecar } = await import('../../apps/desktop/src/shared/clipFiles.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-export-game-'))
  try {
    if (safe) {
      // No screen, audio, encoder or capture initialization is needed to check
      // native output refusal and cleanup against a deliberately invalid input.
      const input = path.join(dir, 'invalid.mp4')
      const existing = path.join(dir, 'existing.mp4')
      fs.writeFileSync(input, 'invalid media fixture')
      fs.writeFileSync(existing, 'keep original output')
      const before = fs.readFileSync(existing)
      await assert.rejects(addon.exportClip(input, existing, { maxBytes: 1000000 }))
      await assert.rejects(addon.trimClip(input, existing, 0, 1))
      assert.deepEqual(fs.readFileSync(existing), before)
      for (const operation of ['export', 'trim']) {
        const output = path.join(dir, `${operation}.mp4`)
        await assert.rejects(operation === 'export'
          ? addon.exportClip(input, output, { maxBytes: 1000000 })
          : addon.trimClip(input, output, 0, 1))
        assert.equal(fs.existsSync(output), false)
      }
      assert.equal(fs.readdirSync(dir).some(name => name.includes('.partial.')), false)
      console.log('PASS: safe native export/trim preserve existing bytes and failed outputs leave no partials')
      return
    }
    const initialized = addon.initialize(dir, 0)
    assert.equal(initialized.error, undefined)
    const startupMode = addon.getStatus().audioMode
    addon.setQuality({ height: 720, fps: 30, bitrateKbps: 4000 })
    addon.setCurrentGame('Probe Game', process.pid)
    assert.equal(addon.startReplayBuffer(), true)
    await wait(6000)
    const pending = addon.saveClip(4)
    addon.setCurrentGame('', 0)
    const clip = await pending
    assert.equal(clip.game, 'Probe Game')
    writeSidecar(clip.path, { duration: clip.duration, game: clip.game })
    assert.equal(readSidecar(clip.path).game, 'Probe Game')
    assert.equal(addon.getStatus().audioMode, startupMode)
    const idle = await addon.saveClip(2)
    assert.equal(idle.game, 'Unknown')
    assert.equal(path.basename(path.dirname(idle.path)), 'Unknown')
    addon.stopReplayBuffer()
    console.log(`PASS: pending save keeps Probe Game; next save is Unknown; audio restored to ${startupMode}`)

    const requested = path.join(dir, 'share - 10MB.mp4')
    const maxBytes = 10 * 1024 * 1024
    const exportCopy = async () => {
      const output = reserveOutput(requested)
      try { return await addon.exportClip(clip.path, output.path, { maxBytes }) }
      finally { output.release() }
    }
    const [first, second] = await Promise.all([exportCopy(), exportCopy()])
    assert.notEqual(first.path, second.path)
    for (const result of [first, second]) {
      assert.equal(fs.existsSync(result.path), true)
      assert.equal(result.bytes <= maxBytes && result.bytes > 0, true)
    }
    assert.equal(path.basename(second.path), 'share - 10MB (2).mp4')
    console.log(`PASS: two exports coexist (${first.bytes} and ${second.bytes} bytes, budget ${maxBytes})`)

    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const before = digest(first.path)
    await assert.rejects(addon.exportClip(clip.path, first.path, { maxBytes: 1 }), /already exists/)
    assert.equal(digest(first.path), before)
    await assert.rejects(addon.exportClip(clip.path, path.join(dir, 'impossible.mp4'), { maxBytes: 1 }), /budget is too small/)
    await assert.rejects(addon.exportClip(clip.path, path.join(dir, 'failed.mp4'), { maxBytes, startSeconds: 1000 }), /no video/)
    assert.equal(fs.readdirSync(dir).some(name => name.includes('.partial.')), false)
    assert.equal(fs.existsSync(path.join(dir, 'impossible.mp4')), false)
    assert.equal(fs.existsSync(path.join(dir, 'failed.mp4')), false)
    console.log('PASS: failed exports preserve earlier copy and leave no partial or published file')

    const tiny = path.join(dir, 'tiny.mp4')
    await assert.rejects(addon.exportClip(clip.path, tiny, {
      maxBytes: 2000, startSeconds: 0, endSeconds: 0.001,
    }), /still exceeds the requested size budget after retry/)
    assert.equal(fs.existsSync(tiny), false)
    assert.equal(fs.readdirSync(dir).some(name => name.includes('.partial.')), false)
    console.log('PASS: measured oversize retries once, reports the budget error and removes the partial')

    const trimmed = []
    for (let index = 0; index < 2; index++) {
      const output = reserveOutput(path.join(dir, 'trim.mp4'))
      try { trimmed.push(await addon.trimClip(clip.path, output.path, 0, 2)) }
      finally { output.release() }
    }
    assert.notEqual(trimmed[0].path, trimmed[1].path)
    for (const result of trimmed) assert.equal(fs.statSync(result.path).size > 0, true)
    await assert.rejects(addon.trimClip(clip.path, trimmed[0].path, 0, 2), /already exists/)
    console.log('PASS: repeated trims coexist and native trim refuses existing destinations')
  } finally {
    addon.stopReplayBuffer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
