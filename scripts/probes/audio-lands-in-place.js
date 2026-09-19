// Sound in the first half only. The silence fill must not move it, flatten it,
// or write over it - it covers the whole clip now, so this is the check that it
// only fills where a track really has nothing.
const addon = require('./addon')
const { execFileSync } = require('child_process')
const os = require('os'), path = require('path'), fs = require('fs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-place-'))
const wait = ms => new Promise(r => setTimeout(r, ms))
const beep = () => execFileSync('powershell', ['-NoProfile', '-Command',
  '1..8 | ForEach-Object { [console]::beep(880, 400) }'], { stdio: 'pipe' })
;(async () => {
  addon.initialize(dir, 0); addon.setBufferLength(30); addon.startReplayBuffer()
  addon.setAudioTracks({ game: true, mic: true, other: true })
  await wait(1500)
  beep()                      // roughly the first 3.2s of what we save
  await wait(9000)            // then silence
  const clip = await addon.saveClip(12)
  const audio = await addon.decodeClipAudio(clip.path)
  addon.stopReplayBuffer()

  const loud = audio.tracks.map(track => {
    const windows = []
    const seconds = track.samples.length / audio.sampleRate
    for (let start = 0; start < seconds - 1; start += 2) {
      const from = Math.floor(start * audio.sampleRate)
      const to = Math.min(track.samples.length, Math.floor((start + 2) * audio.sampleRate))
      let total = 0
      for (let i = from; i < to; i++) total += track.samples[i] * track.samples[i]
      windows.push(Math.sqrt(total / Math.max(1, to - from)))
    }
    console.log(`  ${track.id.padEnd(6)} ${seconds.toFixed(2)}s  ` + windows.map(w => w.toFixed(4)).join(' '))
    return { id: track.id, windows }
  })
  fs.rmSync(dir, { recursive: true, force: true })
  const other = loud.find(t => t.id === 'other')
  const peakAt = other ? other.windows.indexOf(Math.max(...other.windows)) : -1
  const half = other ? Math.floor(other.windows.length / 2) : 0
  console.log(peakAt >= 0 && peakAt < half
    ? `PASS: the loudest window is ${peakAt} of ${other.windows.length}, in the first half where the sound was`
    : `FAIL: loudest window is ${peakAt} of ${other ? other.windows.length : 0}`)
})().catch(e => { console.error('ERROR', e.message); process.exit(1) })
