const addon = require('./addon')
const { execFileSync } = require('child_process')
const os = require('os'), path = require('path'), fs = require('fs')
const setres = path.join(__dirname, 'set-resolution.ps1')
const shots = path.join(__dirname, 'out'); fs.mkdirSync(shots, { recursive: true })
const resolution = (w, h) => execFileSync('powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setres, '-Width', String(w), '-Height', String(h)],
  { encoding: 'utf8' }).trim().split('\n').pop().trim()
const dims = f => { const b = fs.readFileSync(f); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` }
const wait = ms => new Promise(r => setTimeout(r, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-shot2-'))
const shot = async name => {
  const file = path.join(shots, `${name}.png`)
  await addon.saveScreenshot(file)
  const s = addon.getStatus()
  console.log(`${name.padEnd(16)} ${dims(file)}  ${(fs.statSync(file).size / 1000).toFixed(0)}KB  engine=${s.width}x${s.height} healthy=${s.captureHealthy}`)
}
;(async () => {
  addon.initialize(dir, 0); addon.startReplayBuffer(); await wait(3000)
  await shot('a-1080p')
  resolution(1280, 720)
  for (const [n, ms] of [['b-720-1s', 1000], ['c-720-3s', 2000], ['d-720-6s', 3000]]) { await wait(ms); await shot(n) }
  resolution(1920, 1080)
  for (const [n, ms] of [['e-back-1s', 1000], ['f-back-3s', 2000], ['g-back-6s', 3000]]) { await wait(ms); await shot(n) }
  addon.stopReplayBuffer(); fs.rmSync(dir, { recursive: true, force: true })
})().catch(e => console.error('ERROR', e)).finally(() => { try { resolution(1920, 1080) } catch {} })
