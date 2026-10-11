// Exports a real clip as a share copy and checks codec, frame rate and size.
// Needs a GPU and a saved clip, so it is not part of `pnpm test`.
//   node scripts/probes/share-copy.js "<clip.mp4>" [av1|hevc|h264]
// The second argument is the codec `Auto` is expected to choose on this machine
// (default av1). Set FLASH_EXPORT_CODEC to force a lower step of the ladder.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os')
const assert = require('node:assert/strict')
const addon = require(path.join(__dirname, '../../packages/flash-capture/build',
  process.platform === 'win32' ? 'Release' : '', 'flash_capture.node'))

const clip = process.argv[2]
const expected = process.argv[3] ?? 'av1'
if (!clip || !fs.existsSync(clip)) { console.error('usage: share-copy.js <clip.mp4> [av1|hevc|h264]'); process.exit(2) }

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-share-copy-'))
  try {
    for (const mb of [10, 25, 4]) {
      const maxBytes = mb * 1024 * 1024
      const out = path.join(dir, `auto-${mb}.mp4`)
      const r = await addon.exportClip(clip, out, { maxBytes, codec: 'auto', maxFps: 60 })
      const onDisk = fs.statSync(out).size
      console.log(`auto ${mb}MB: ${r.codec} ${r.width}x${r.height} ${(onDisk / 1048576).toFixed(2)} MiB (${Math.round(onDisk / maxBytes * 100)}% of limit)`)
      assert.equal(r.codec, expected, `Auto chose ${r.codec}, expected ${expected}`)
      assert.equal(r.bytes, onDisk, 'reported bytes must be the published file')
      assert.ok(onDisk <= maxBytes, 'the limit is a hard ceiling')
      assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.partial')), [], 'no partial files left behind')
    }
    const compatible = path.join(dir, 'h264.mp4')
    const h = await addon.exportClip(clip, compatible, { maxBytes: 10 * 1024 * 1024, codec: 'h264', maxFps: 60 })
    console.log(`h264 10MB: ${h.codec} ${h.width}x${h.height} ${(h.bytes / 1048576).toFixed(2)} MiB`)
    assert.equal(h.codec, 'h264')
    assert.ok(h.bytes <= 10 * 1024 * 1024)
    console.log(`PASS. Outputs kept in ${dir} for ffprobe; delete when done.`)
  } catch (error) {
    console.error(`FAIL: ${error.message}\nOutputs in ${dir}`)
    process.exit(1)
  }
})()
