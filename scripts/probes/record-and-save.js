// End-to-end regression check after the capture-engine edits: record for 20s,
// save the whole buffer, and confirm the clip is real — non-trivial size, the
// duration asked for, video frames, and audio tracks.
const addon = require('./addon')
const os = require('os'), path = require('path'), fs = require('fs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-e2e-'))
console.log('init:', JSON.stringify(addon.initialize(dir, 0)))
addon.setBufferLength(30)
console.log('started:', addon.startReplayBuffer())
const wait = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  await wait(20000)
  const before = addon.getStatus()
  console.log(`before save: recording=${before.recording} healthy=${before.captureHealthy} buffer=${before.bufferSeconds.toFixed(1)}s`)
  const clip = await addon.saveClip()
  const bytes = fs.statSync(clip.path).size
  console.log(`saved: ${clip.duration.toFixed(2)}s  ${(bytes / 1e6).toFixed(1)} MB`)
  const keys = await addon.getClipKeyframes(clip.path)
  console.log(`keyframes: ${keys.keyframesSec.length}  duration=${keys.durationSeconds.toFixed(2)}s  ${keys.bitrateKbps} kbps`)
  const audio = await addon.decodeClipAudio(clip.path)
  console.log(`audio tracks: ${audio.tracks.map(t => `${t.id}(${(t.samples.length / audio.sampleRate).toFixed(1)}s)`).join(' ') || 'none'}`)
  const after = addon.getStatus()
  console.log(`after save: recording=${after.recording} healthy=${after.captureHealthy} error=${after.captureError || 'none'}`)
  addon.stopReplayBuffer()

  const ok = clip.duration > 15 && bytes > 2e6 && keys.keyframesSec.length >= 2 &&
    audio.tracks.length === 3 && after.recording === true && after.captureHealthy !== false
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})().catch(error => { console.error('ERROR', error); process.exit(2) })
