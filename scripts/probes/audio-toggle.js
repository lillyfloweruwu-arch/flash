// Proves the audio switch actually reaches the recording: record while a tone
// plays with audio on, then with audio off, and compare the decoded RMS.
const addon = require('./addon')
const { execFileSync } = require('child_process')
const os = require('os'), path = require('path'), fs = require('fs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-audio-'))
addon.initialize(dir, 0)
addon.startReplayBuffer()

const wait = ms => new Promise(r => setTimeout(r, ms))
const beep = () => execFileSync('powershell', ['-NoProfile', '-Command',
  '1..6 | ForEach-Object { [console]::beep(880, 300) }'], { stdio: 'pipe' })

const rms = samples => {
  let total = 0
  for (const value of samples) total += value * value
  return Math.sqrt(total / (samples.length || 1))
}

;(async () => {
  const runs = []
  for (const on of [true, false]) {
    addon.setAudioTracks({ game: on, mic: on, other: on })
    // Long enough that nothing from the previous phase can still be inside the
    // 3-second window this phase saves.
    await wait(6000)
    beep()
    await wait(300)
    const clip = await addon.saveClip(3)
    const decoded = await addon.decodeClipAudio(clip.path)
    const perTrack = decoded.tracks.map(t => `${t.id}=${rms(t.samples).toFixed(5)}`)
    const loudest = Math.max(...decoded.tracks.map(t => rms(t.samples)))
    runs.push({ on, loudest })
    console.log(`audio ${on ? 'ON ' : 'OFF'}: ${perTrack.join('  ')}   loudest=${loudest.toFixed(5)}`)
  }
  addon.stopReplayBuffer()
  fs.rmSync(dir, { recursive: true, force: true })
  const [onRun, offRun] = runs
  const verdict = offRun.loudest < onRun.loudest / 10 && offRun.loudest < 1e-3
  console.log(verdict ? 'PASS: audio off records silence' : 'FAIL: audio off still recorded sound')
  process.exit(verdict ? 0 : 1)
})().catch(error => { console.error('ERROR', error); process.exit(2) })
