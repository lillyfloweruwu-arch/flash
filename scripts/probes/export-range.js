// Exports a range that starts mid-GOP and checks the result actually begins
// where it was asked to.
const addon = require('./addon')
const os = require('os'), path = require('path'), fs = require('fs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-export-'))
addon.initialize(dir, 0)
addon.startReplayBuffer()
const wait = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  await wait(20000)
  const clip = await addon.saveClip()
  const keys = await addon.getClipKeyframes(clip.path)
  console.log(`source: ${clip.duration.toFixed(2)}s, keyframes at ${keys.keyframesSec.slice(0, 6).map(k => k.toFixed(2)).join(' ')} ...`)

  // Deliberately between two keyframes, which is the case that used to carry
  // everything from the previous keyframe onwards.
  const kf = keys.keyframesSec.find(k => k > 3) ?? 3
  const start = kf + 0.6
  const end = start + 4
  const output = path.join(dir, 'ranged.mp4')
  const variants = [
    ['MAX_SAFE_INTEGER (what the editor sends)', Number.MAX_SAFE_INTEGER],
    ['2 GB', 2 * 1024 * 1024 * 1024],
    ['100 MB', 100 * 1024 * 1024],
    ['10 MB', 10 * 1024 * 1024],
  ]
  let result = null
  for (const [label, maxBytes] of variants) {
    try {
      result = await addon.exportClip(clip.path, path.join(dir, `ranged-${maxBytes}.mp4`), {
        maxBytes, startSeconds: start, endSeconds: end,
      })
      console.log(`  ${label}: ok, ${result.duration.toFixed(3)}s ${result.width}x${result.height} ${result.bitrateKbps}kbps`)
    } catch (error) {
      console.log(`  ${label}: FAILED ${error.message}`)
    }
  }
  if (!result) { addon.stopReplayBuffer(); return }
  const output2 = path.join(dir, `ranged-${10 * 1024 * 1024}.mp4`)
  void output2
  const audio = await addon.decodeClipAudio(path.join(dir, `ranged-${10 * 1024 * 1024}.mp4`))
  const audioSeconds = Math.max(...audio.tracks.map(t => t.samples.length / audio.sampleRate))

  console.log(`asked for ${start.toFixed(2)}s..${end.toFixed(2)}s  (${(end - start).toFixed(2)}s)`)
  console.log(`got video ${result.duration.toFixed(3)}s, audio ${audioSeconds.toFixed(3)}s, ${(result.bytes / 1e6).toFixed(2)} MB`)
  console.log(`video error ${(result.duration - (end - start)).toFixed(3)}s, audio error ${(audioSeconds - (end - start)).toFixed(3)}s`)

  addon.stopReplayBuffer()
  const ok = Math.abs(result.duration - (end - start)) < 0.2 && Math.abs(audioSeconds - (end - start)) < 0.25
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(ok ? 'PASS: the export starts where it was asked to' : 'FAIL: the export is not the requested range')
})().catch(error => { console.error('ERROR', error) })
