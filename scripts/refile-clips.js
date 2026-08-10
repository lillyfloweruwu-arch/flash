// One-off: re-file clips that were saved under the wrong game.
//
// Flash used to pick the first known game in the process list rather than the one
// being played, so clips could land in the wrong folder. There is no historical
// record of which game was running when, so the only reliable signal is the video
// itself.
//
//   extract  — pull a frame out of every clip so they can be identified by eye
//   apply    — move clips (and their sidecars) into the right game folder
//
// Usage, from the repo root:
//   apps/desktop/node_modules/.bin/electron scripts/refile-clips.js extract [outDir]
//   node scripts/refile-clips.js apply moves.json [--dry-run]
//
// moves.json is { "<current clip path>": "<correct game name>", ... }

const { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, renameSync, statSync } = require('fs')
const { join, dirname, basename } = require('path')

const LIBRARY = process.env.FLASH_CLIPS || 'C:/Users/emers/Videos/Flash'

function listClips() {
  const clips = []
  if (!existsSync(LIBRARY)) return clips
  for (const game of readdirSync(LIBRARY)) {
    const dir = join(LIBRARY, game)
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const file of entries) {
      if (!file.endsWith('.mp4')) continue
      clips.push({ game, file, path: join(dir, file), size: statSync(join(dir, file)).size })
    }
  }
  return clips
}

async function extract(outDir) {
  const { app, BrowserWindow } = require('electron')
  // Never fight a running game for the GPU: this decodes in software.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('no-sandbox')

  await app.whenReady()
  mkdirSync(outDir, { recursive: true })
  const clips = listClips()
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } })
  await win.loadURL('data:text/html,<video id=v></video><canvas id=c></canvas>')

  const index = []
  for (const clip of clips) {
    const url = 'file:///' + clip.path.replace(/\\/g, '/')
    const dataUrl = await win.webContents.executeJavaScript(`
      new Promise(resolve => {
        const v = document.getElementById('v'), c = document.getElementById('c')
        v.onerror = () => resolve(null)
        v.onloadeddata = () => {
          v.onseeked = () => {
            // Half size keeps the contact sheet small but still readable.
            c.width = Math.min(640, v.videoWidth); c.height = c.width * v.videoHeight / v.videoWidth
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
            resolve(c.toDataURL('image/jpeg', 0.7))
          }
          v.currentTime = Math.min(3, v.duration / 2)   // past any fade-in
        }
        setTimeout(() => resolve(null), 15000)
        v.src = ${JSON.stringify(url)}
      })
    `)
    if (!dataUrl) { console.log(`  skip (no frame): ${clip.file}`); continue }
    const name = `${clip.game}__${basename(clip.file, '.mp4')}.jpg`
    writeFileSync(join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'))
    index.push({ frame: name, path: clip.path, currentGame: clip.game })
    console.log(`  ${name}`)
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2))
  console.log(`\n${index.length} frames -> ${outDir}`)
  app.exit(0)
}

function apply(movesFile, dryRun) {
  const moves = JSON.parse(readFileSync(movesFile, 'utf8'))
  let moved = 0
  for (const [from, game] of Object.entries(moves)) {
    if (!existsSync(from)) { console.log(`  missing: ${from}`); continue }
    const target = join(LIBRARY, game)
    const to = join(target, basename(from))
    if (from === to) continue
    if (existsSync(to)) { console.log(`  exists, skipping: ${to}`); continue }
    console.log(`  ${basename(dirname(from))}/${basename(from)}  ->  ${game}/`)
    if (dryRun) { moved++; continue }
    mkdirSync(target, { recursive: true })
    renameSync(from, to)
    // The sidecar carries the game name too, so move and rewrite it or the
    // library will keep showing the old one.
    const sidecarFrom = from.replace(/\.mp4$/i, '.json')
    if (existsSync(sidecarFrom)) {
      try {
        const data = JSON.parse(readFileSync(sidecarFrom, 'utf8'))
        data.game = game
        writeFileSync(to.replace(/\.mp4$/i, '.json'), JSON.stringify(data))
        require('fs').unlinkSync(sidecarFrom)
      } catch { /* sidecar is an optimisation, not required */ }
    }
    moved++
  }
  console.log(`\n${dryRun ? 'would move' : 'moved'} ${moved} clip(s)`)
}

const [, , command, arg, flag] = process.argv
if (command === 'extract') extract(arg || join(process.cwd(), 'clip-frames')).catch(e => { console.error(e); process.exit(1) })
else if (command === 'apply') apply(arg, flag === '--dry-run')
else {
  console.log('usage: extract [outDir]  |  apply <moves.json> [--dry-run]')
  for (const c of listClips()) console.log(`  ${c.game.padEnd(18)} ${c.file}  ${(c.size / 1048576).toFixed(1)}MB`)
}
