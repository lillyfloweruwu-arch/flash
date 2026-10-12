// A clip's audio tracks are named by their place in the file. This pins that
// reading a clip agrees with writing it: a tone recorded on the Music track
// (the last one) must decode as `music`, be removed from an export by the
// music gain and by no other, and still be `music` after a trim. The source
// reader lists streams in an order of its own, and before this probe existed
// decode, export and trim each took that for the file's order.
// Needs a sound device. Not part of `pnpm test`. The installed Flash may stay
// running.
//   node scripts/probes/track-order.js
const addon = require('./addon')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawn } = require('node:child_process')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-order-'))

// Six seconds of a 440 Hz tone at half scale, 48 kHz stereo 16-bit.
function writeTone(file) {
  const rate = 48000, seconds = 6, frames = rate * seconds
  const data = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 16000)
    data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22)
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([head, data]))
}

const dB = samples => {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

async function levels(file) {
  const audio = await addon.decodeClipAudio(file)
  return audio.tracks.map(t => ({ id: t.id, dB: dB(t.samples) }))
}
const show = tracks => tracks.map(t => `${t.id}=${t.dB.toFixed(1)}dB`).join('  ')
const level = (tracks, id) => tracks.find(t => t.id === id).dB

;(async () => {
  const tone = path.join(dir, 'tone.wav')
  writeTone(tone)
  assert.equal(addon.capabilities.perAppAudio, true, 'this probe puts a tone on the Music lane, which needs per-app audio')
  addon.initialize(dir, 0)
  addon.setAudioLanes({ discord: [], music: ['powershell.exe'] })
  // Only the first and the last track record, so nothing else on the machine
  // can stand in for the tone.
  addon.setAudioTracks({ game: true, mic: false, other: false, discord: false, music: true })
  addon.setBufferLength(20)
  addon.startReplayBuffer()

  // Through `cmd /c start` so the player is not a child of this process.
  spawn('cmd', ['/c', 'start', '', '/b', 'powershell', '-NoProfile', '-Command',
    `(New-Object System.Media.SoundPlayer '${tone}').PlaySync()`], { detached: true, stdio: 'ignore' }).unref()
  await wait(7000)
  const clip = await addon.saveClip(5)
  addon.stopReplayBuffer()

  const recorded = await levels(clip.path)
  console.log('recorded:           ' + show(recorded))
  assert.deepEqual(recorded.map(t => t.id), ['game', 'mic', 'other', 'discord', 'music'])
  assert.ok(level(recorded, 'music') > -40, `music should carry the tone, was ${level(recorded, 'music').toFixed(1)} dB`)
  for (const id of ['game', 'mic', 'other', 'discord'])
    assert.ok(level(recorded, id) < -70, `${id} should be silent, was ${level(recorded, id).toFixed(1)} dB`)

  // An export is one mixed track. Muting Music must remove the tone; muting
  // Game must not.
  const unlimited = Number.MAX_SAFE_INTEGER
  const withoutMusic = await addon.exportClip(clip.path, path.join(dir, 'no-music.mp4'), { maxBytes: unlimited, gains: { music: 0 } })
  const withoutGame = await addon.exportClip(clip.path, path.join(dir, 'no-game.mp4'), { maxBytes: unlimited, gains: { game: 0 } })
  const quiet = Math.max(...(await levels(withoutMusic.path)).map(t => t.dB))
  const loud = Math.max(...(await levels(withoutGame.path)).map(t => t.dB))
  console.log(`export, music muted: ${quiet.toFixed(1)}dB`)
  console.log(`export, game muted:  ${loud.toFixed(1)}dB`)
  assert.ok(quiet < -70, `an export with Music muted should be silent, was ${quiet.toFixed(1)} dB`)
  assert.ok(loud > -40, `an export with Game muted should still carry the tone, was ${loud.toFixed(1)} dB`)

  // A trim copies the tracks; they must stay where they were.
  const trimmed = await addon.trimClip(clip.path, path.join(dir, 'trimmed.mp4'), 0, 3)
  const afterTrim = await levels(trimmed.path)
  console.log('trimmed:            ' + show(afterTrim))
  assert.deepEqual(afterTrim.map(t => t.id), ['game', 'mic', 'other', 'discord', 'music'])
  assert.ok(level(afterTrim, 'music') > -40, `after a trim music should carry the tone, was ${level(afterTrim, 'music').toFixed(1)} dB`)
  assert.ok(level(afterTrim, 'game') < -70, `after a trim game should be silent, was ${level(afterTrim, 'game').toFixed(1)} dB`)

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('PASS')
})().catch(error => {
  console.error('FAIL:', error.message)
  try { addon.stopReplayBuffer() } catch { /* already stopped */ }
  process.exit(1)
})
