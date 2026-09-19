// One clip, every keyframe, several seek offsets. Which offset lands on the
// keyframe you asked for instead of the one before it?
const addon = require('./addon')
const os = require('os'), path = require('path'), fs = require('fs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-offset-'))
addon.initialize(dir, 0); addon.startReplayBuffer()
const wait = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  await wait(15000)
  const clip = await addon.saveClip()
  const keys = await addon.getClipKeyframes(clip.path)
  const offsets = [0, 0.0005, 0.001, 0.004, 0.008]
  console.log('offset(ms)  ' + keys.keyframesSec.slice(1, 8).map((k, i) => `kf${i + 1}`.padStart(8)).join(''))
  for (const offset of offsets) {
    const cells = []
    for (const kf of keys.keyframesSec.slice(1, 8)) {
      const out = path.join(dir, `o-${offset}-${kf.toFixed(4)}.mp4`)
      const r = await addon.trimClip(clip.path, out, kf + offset, kf + offset + 2)
      const drift = (r.actualStartSeconds ?? 0) - kf
      cells.push((Math.abs(drift) < 0.02 ? 'ok' : drift.toFixed(2)).padStart(8))
    }
    console.log(String(offset * 1000).padEnd(12) + cells.join(''))
  }
  addon.stopReplayBuffer(); fs.rmSync(dir, { recursive: true, force: true })
})().catch(e => console.error('ERROR', e))
