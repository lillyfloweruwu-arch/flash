const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawn } = require('node:child_process')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

;(async () => {
  if (process.platform !== 'win32') { console.log('SKIP: Windows deny-delete sharing probe'); return }
  const { createClipDeletion } = await import('../../apps/desktop/src/shared/clipDeletion.ts')
  const { writeSidecar, readSidecar } = await import('../../apps/desktop/src/shared/clipFiles.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-delete-lock-'))
  const file = path.join(dir, 'fixture.mp4')
  fs.writeFileSync(file, 'keep starred recording')
  const holder = spawn('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'lock-fixture.ps1'), '-Fixture', file],
    { windowsHide: true, stdio: 'inherit' })
  let exited = false, spawnError
  const closed = new Promise(resolve => {
    holder.once('error', error => { spawnError = error; exited = true; resolve() })
    holder.once('exit', () => { exited = true; resolve() })
  })
  try {
    const deadline = Date.now() + 5000
    while (!fs.existsSync(`${file}.locked`) && !exited && Date.now() < deadline) await wait(20)
    if (spawnError) throw spawnError
    assert(fs.existsSync(`${file}.locked`), 'lock holder did not become ready')
    let attempts = 0
    const deletion = createClipDeletion({
      allowed: (file, intent) => intent === 'manual' || !readSidecar(file)?.starred,
      unlink: file => { attempts++; fs.unlinkSync(file) },
      cleanup: () => {},
      wait: async () => {
        writeSidecar(file, { starred: true })
        fs.writeFileSync(`${file}.release`, '')
        await closed
      },
    })
    assert.equal((await deletion.remove(file, 'prune')).deleted, false)
    assert.equal(attempts, 1)
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep starred recording')
    assert.equal((await deletion.remove(file, 'manual')).deleted, true)
    assert.equal(fs.existsSync(file), false)
    console.log('PASS: real Windows deny-delete handle; star during retry survives release; confirmed manual delete succeeds')
  } finally {
    fs.writeFileSync(`${file}.release`, '')
    await closed
    fs.rmSync(dir, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
