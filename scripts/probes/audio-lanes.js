// Per-app audio lanes on real hardware. A helper process plays a tone; its
// executable is assigned to Music, then to Discord, and the tone has to follow.
// Needs a sound device. Not part of `pnpm test`. The installed Flash may stay
// running. Whatever else is playing on the machine lands in "other" and is not
// judged.
//   node scripts/probes/audio-lanes.js
const addon = require('./addon')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawn } = require('node:child_process')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-lanes-'))

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

// Started through `cmd /c start` so the player is not a child of this process:
// Flash never records its own process tree, and a direct child would count.
function playTone(file) {
  spawn('cmd', ['/c', 'start', '', '/b', 'powershell', '-NoProfile', '-Command',
    `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`], { detached: true, stdio: 'ignore' }).unref()
}

const dB = samples => {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

async function record(label) {
  await wait(7000)
  const clip = await addon.saveClip(5)
  const audio = await addon.decodeClipAudio(clip.path)
  const levels = Object.fromEntries(audio.tracks.map(t => [t.id, dB(t.samples)]))
  console.log(`${label}: ` + audio.tracks.map(t => `${t.id}=${levels[t.id].toFixed(1)}dB`).join('  '))
  assert.deepEqual(audio.tracks.map(t => t.id), ['game', 'mic', 'other', 'discord', 'music'])
  return levels
}

;(async () => {
  const tone = path.join(dir, 'tone.wav')
  writeTone(tone)
  assert.equal(addon.capabilities.perAppAudio, true, 'per-app audio should be available on this machine')
  console.log('init:', JSON.stringify(addon.initialize(dir, 0)))
  addon.setAudioLanes({ discord: [], music: ['powershell.exe'] })
  addon.setBufferLength(20)
  addon.startReplayBuffer()
  assert.equal(addon.getStatus().audioMode, 'separate')

  playTone(tone)
  await wait(3000)
  const apps = addon.listAudioApps()
  console.log('apps:', apps.map(a => `${a.exe}->${a.lane}${a.capturing ? '' : ' (idle)'}`).join(', '))
  const player = apps.find(a => a.exe.toLowerCase() === 'powershell.exe')
  assert.ok(player, 'the tone player should be listed')
  assert.equal(player.lane, 'music')
  assert.equal(player.capturing, true)
  assert.ok(!apps.some(a => a.exe.toLowerCase() === 'node.exe'), 'this process must not be listed: Flash does not record itself')

  const first = await record('tone assigned to music')
  assert.ok(first.music > -40, `music should carry the tone, was ${first.music.toFixed(1)} dB`)
  assert.ok(first.discord < -70, `discord should be silent, was ${first.discord.toFixed(1)} dB`)
  assert.ok(first.game < -70, 'no game is set, so the game track is silent')

  // Reassign while recording: no restart, and the next clip follows.
  addon.setAudioLanes({ discord: ['powershell.exe'], music: [] })
  await wait(8000)   // let the first tone finish and its audio leave the 5 s window
  playTone(tone)
  const second = await record('tone assigned to discord')
  assert.ok(second.discord > -40, `discord should carry the tone, was ${second.discord.toFixed(1)} dB`)
  assert.ok(second.music < -70, `music should be silent, was ${second.music.toFixed(1)} dB`)

  // Record audio off, then on again: every lane stops and resumes.
  const off = { game: false, mic: false, other: false, discord: false, music: false }
  addon.setAudioTracks(off)
  await wait(8000)
  playTone(tone)
  await wait(7000)
  const silent = await addon.saveClip(5)
  const silentAudio = await addon.decodeClipAudio(silent.path)
  console.log(`audio off: ${silentAudio.tracks.length} track(s) ` + silentAudio.tracks.map(t => `${t.id}=${dB(t.samples).toFixed(1)}dB`).join('  '))
  for (const t of silentAudio.tracks) assert.ok(dB(t.samples) < -70, `${t.id} should be silent with audio off`)
  addon.setAudioTracks({ game: true, mic: true, other: true, discord: true, music: true })
  await wait(8000)
  playTone(tone)
  const third = await record('audio back on')
  assert.ok(third.discord > -40, 'discord should carry the tone again')

  addon.stopReplayBuffer()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('PASS')
})().catch(error => {
  console.error('FAIL:', error.message)
  try { addon.stopReplayBuffer() } catch { /* already stopped */ }
  process.exit(1)
})
