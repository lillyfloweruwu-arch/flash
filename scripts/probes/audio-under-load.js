// Does audio keep its length against video when the machine is busy?
//
// Each WASAPI packet is stamped at drain time minus its own duration. When the
// capture thread is delayed and several packets have queued, they all land near
// the drain instant instead of at their real sequential times, so the audio
// timeline loses the time the backlog represents. Recording under load and
// comparing the decoded audio length against the video length makes that visible.
const addon = require('./addon')
const { fork } = require('child_process')
const os = require('os'), path = require('path'), fs = require('fs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-drift-'))
const wait = ms => new Promise(r => setTimeout(r, ms))
const burner = path.join(dir, 'burn.js')
fs.writeFileSync(burner, 'const end = Date.now() + Number(process.argv[2]); let x = 0;' +
  'while (Date.now() < end) { for (let i = 0; i < 1e6; i++) x += Math.sqrt(i) } process.exit(0)')

async function run(label, loadMs) {
  addon.initialize(dir, 0)
  addon.setBufferLength(40)
  addon.startReplayBuffer()
  await wait(2000)
  const workers = []
  if (loadMs) for (let i = 0; i < os.cpus().length * 2; i++) workers.push(fork(burner, [String(loadMs)], { stdio: 'ignore' }))
  await wait(20000)
  for (const worker of workers) { try { worker.kill() } catch {} }
  const clip = await addon.saveClip(18)
  const keys = await addon.getClipKeyframes(clip.path)
  const audio = await addon.decodeClipAudio(clip.path)
  addon.stopReplayBuffer()

  const lengths = audio.tracks.map(t => t.samples.length / audio.sampleRate)
  const video = keys.durationSeconds
  const worst = Math.min(...lengths)
  console.log(`${label.padEnd(18)} video ${video.toFixed(3)}s  audio ` +
    audio.tracks.map((t, i) => `${t.id}=${lengths[i].toFixed(3)}`).join(' ') +
    `  shortfall ${(video - worst).toFixed(3)}s`)
  return video - worst
}

;(async () => {
  const idle = await run('idle', 0)
  const loaded = await run('under load', 18000)
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\nshortfall idle ${idle.toFixed(3)}s vs loaded ${loaded.toFixed(3)}s`)
  console.log(loaded - idle > 0.25
    ? 'REPRODUCED: audio loses time against video when the machine is busy'
    : 'not reproduced at this load level')
})().catch(e => { console.error('ERROR', e); process.exit(2) })
