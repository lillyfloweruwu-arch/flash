// Re-applying the settings already in force must not reset the replay.
// The app does this on every game change, and before 2026-10-09 it did it on
// every 3 s poll while no game ran, so the buffer never grew past 3 seconds.
//   node scripts/probes/reapply-settings.js
const addon = require('./addon')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  addon.initialize()
  const quality = { height: 720, fps: 30, bitrateKbps: 6000 }
  addon.setQuality(quality)
  addon.setBufferLength(15)
  addon.startReplayBuffer()
  await sleep(6000)
  const before = addon.getStatus().bufferSeconds
  for (let i = 0; i < 3; i++) {
    addon.setBufferLength(15)
    addon.setQuality(quality)
    await sleep(1000)
  }
  const after = addon.getStatus().bufferSeconds
  addon.stopReplayBuffer()
  console.log(`buffered before re-apply: ${before.toFixed(1)}s, after 3 re-applies + 3 s: ${after.toFixed(1)}s`)
  const ok = before > 4 && after > before + 2
  console.log(ok ? 'PASS: re-applying settings kept the replay' : 'FAIL: the replay was reset')
  process.exitCode = ok ? 0 : 1
})()
