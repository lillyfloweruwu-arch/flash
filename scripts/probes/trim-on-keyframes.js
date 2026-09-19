// Trims starting exactly on every reported keyframe. Anything other than zero
// drift means the planner and the keyframe list disagree about where a keyframe is.
const addon = require('./addon')
const os = require('os'), path = require('path'), fs = require('fs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-sweep-'))
addon.initialize(dir, 0); addon.startReplayBuffer()
const wait = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  await wait(15000)
  const clip = await addon.saveClip()
  const keys = await addon.getClipKeyframes(clip.path)
  console.log(`clip ${clip.duration.toFixed(2)}s, ${keys.keyframesSec.length} keyframes`)
  for (let i = 0; i < Math.min(7, keys.keyframesSec.length); i++) {
    const start = keys.keyframesSec[i]
    for (const span of [3, 4]) {
      const out = path.join(dir, `k${i}-${span}.mp4`)
      const t0 = Date.now()
      const r = await addon.trimClip(clip.path, out, start, start + span)
      const drift = (r.actualStartSeconds ?? 0) - start
      console.log(`  keyframe[${i}] ${start.toFixed(4)}s span ${span}s -> start ${(r.actualStartSeconds ?? 0).toFixed(4)}s ` +
        `drift ${drift.toFixed(4)}s duration ${r.duration.toFixed(3)}s ${Date.now() - t0}ms`)
    }
  }
  addon.stopReplayBuffer(); fs.rmSync(dir, { recursive: true, force: true })
})().catch(e => console.error('ERROR', e))
