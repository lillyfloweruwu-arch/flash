// Exercises every native path the app calls, with the arguments the app sends,
// because two of them turned out to be broken only under real arguments.
const addon = require('./addon')
const os = require('os'), path = require('path'), fs = require('fs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-smoke-'))
addon.initialize(dir, 0)
addon.startReplayBuffer()
const wait = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = async (label, run) => {
  try { const detail = await run(); results.push([label, 'ok', detail ?? '']) }
  catch (error) { results.push([label, 'FAILED', error.message]) }
}

;(async () => {
  await wait(15000)
  let clip = null
  await check('saveClip (full buffer)', async () => {
    clip = await addon.saveClip()
    return `${clip.duration.toFixed(2)}s ${(fs.statSync(clip.path).size / 1e6).toFixed(1)}MB`
  })
  await check('saveClip (short, 5s)', async () => {
    const short = await addon.saveClip(5)
    return `${short.duration.toFixed(2)}s`
  })
  await check('saveScreenshot', async () => {
    const shot = path.join(dir, 'shot.png')
    await addon.saveScreenshot(shot)
    return `${(fs.statSync(shot).size / 1000).toFixed(0)}KB`
  })
  let keys = null
  await check('getClipKeyframes', async () => {
    keys = await addon.getClipKeyframes(clip.path)
    return `${keys.keyframesSec.length} keyframes, ${keys.durationSeconds.toFixed(2)}s`
  })
  await check('trimClip (on a keyframe)', async () => {
    const out = path.join(dir, 'trim-kf.mp4')
    const r = await addon.trimClip(clip.path, out, keys.keyframesSec[2], keys.keyframesSec[2] + 4)
    return `${r.duration.toFixed(2)}s, actual start ${(r.actualStartSeconds ?? 0).toFixed(3)}s`
  })
  await check('trimClip (mid-GOP)', async () => {
    const out = path.join(dir, 'trim-mid.mp4')
    const start = keys.keyframesSec[2] + 0.5
    const r = await addon.trimClip(clip.path, out, start, start + 4)
    return `${r.duration.toFixed(2)}s, actual start ${(r.actualStartSeconds ?? 0).toFixed(3)}s`
  })
  await check('exportClip (10MB share copy)', async () => {
    const out = path.join(dir, 'share.mp4')
    const r = await addon.exportClip(clip.path, out, { maxBytes: 10 * 1024 * 1024 })
    return `${r.width}x${r.height} ${(r.bytes / 1e6).toFixed(2)}MB`
  })
  await check('exportClip (editor save: gains + saturation)', async () => {
    const out = path.join(dir, 'edit.mp4')
    const r = await addon.exportClip(clip.path, out, {
      maxBytes: Number.MAX_SAFE_INTEGER, startSeconds: 2, endSeconds: 6,
      gains: { game: 1, mic: 0, other: 1 }, saturation: 130,
    })
    return `${r.duration.toFixed(2)}s ${r.width}x${r.height}`
  })
  await check('decodeClipAudio', async () => {
    const a = await addon.decodeClipAudio(clip.path)
    return a.tracks.map(t => t.id).join('+')
  })
  await check('listDisplays', async () => addon.listDisplays().map(d => `${d.name} ${d.width}x${d.height}`).join(', '))
  await check('getVoiceStatus', async () => JSON.stringify(addon.getVoiceStatus()))
  await check('listProcesses', async () => `${addon.listProcesses().processes.length} processes`)

  addon.stopReplayBuffer()
  for (const [label, state, detail] of results) {
    console.log(`${state === 'ok' ? ' ok  ' : 'FAIL '} ${label.padEnd(42)} ${detail}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(results.some(r => r[1] !== 'ok') ? 'SOME PATHS FAILED' : 'every native path works')
})().catch(error => { console.error('ERROR', error) })
