// A track that is silent for part of a recording must draw its energy in the
// right place. decodeClipAudio concatenates decoded samples without consulting
// their timestamps, so a track with a gap would come back shifted early.
const addon = require('./addon')
const os = require('os'), path = require('path'), fs = require('fs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-gap-'))
const wait = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  addon.initialize(dir, 0); addon.setBufferLength(40); addon.startReplayBuffer()
  // mic on for the first stretch, off for the second
  addon.setAudioTracks({ game: true, mic: true, other: true })
  await wait(10000)
  addon.setAudioTracks({ game: true, mic: false, other: true })
  await wait(10000)
  const clip = await addon.saveClip(20)
  const audio = await addon.decodeClipAudio(clip.path)
  const keys = await addon.getClipKeyframes(clip.path)
  console.log(`clip ${keys.durationSeconds.toFixed(2)}s, tracks: ${audio.tracks.map(t => t.id).join(' ')}`)
  for (const track of audio.tracks) {
    const seconds = track.samples.length / audio.sampleRate
    const windows = []
    for (let start = 0; start < seconds - 1; start += 2) {
      const from = Math.floor(start * audio.sampleRate)
      const to = Math.min(track.samples.length, Math.floor((start + 2) * audio.sampleRate))
      let total = 0
      for (let i = from; i < to; i++) total += track.samples[i] * track.samples[i]
      windows.push(Math.sqrt(total / Math.max(1, to - from)))
    }
    console.log(`  ${track.id.padEnd(6)} ${seconds.toFixed(2)}s  rms per 2s: ` +
      windows.map(w => w.toFixed(4)).join(' '))
  }
  addon.stopReplayBuffer(); fs.rmSync(dir, { recursive: true, force: true })
})().catch(e => console.error('ERROR', e))
