// Renders one app icon per theme, as PNG (tray/window) and ICO (shortcuts).
// Uses the Electron already installed for the app — no image library.
//
//   pnpm --filter @flash/desktop exec electron ../../scripts/make-icons.js
//
// Output: assets/icons/<theme>.png (512) and assets/icons/<theme>.ico
const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const THEMES = {
  blood:       { bg: '#0C0607', glow: '#2A1017', accent: '#C1121F' },
  ultraviolet: { bg: '#09060F', glow: '#241539', accent: '#B45CFF' },
  cobalt:      { bg: '#070910', glow: '#101F3D', accent: '#4D7CFE' },
  fuchsia:     { bg: '#0D0710', glow: '#330F26', accent: '#FF4FA3' },
  indigo:      { bg: '#080814', glow: '#191740', accent: '#7C74FF' },
  bone:        { bg: '#0A0A0C', glow: '#232327', accent: '#EDE9F5' },
}

const SIZE = 512
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const page = ({ bg, glow, accent }) => `<html><head><style>
  html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:transparent}
  .plate{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle at 32% 26%, ${glow} 0%, ${bg} 72%);border-radius:96px}
  svg{filter:drop-shadow(0 0 26px ${accent}8c)}
</style></head><body><div class="plate">
  <svg width="300" height="300" viewBox="0 0 24 24" fill="none" stroke="${accent}"
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="14" cy="3.5" r="2"/>
    <line x1="14" y1="5.5" x2="12" y2="11"/>
    <line x1="12" y1="8" x2="8.5" y2="6.5"/>
    <line x1="12" y1="8" x2="16" y2="6"/>
    <line x1="12" y1="11" x2="9" y2="16"/>
    <line x1="9" y1="16" x2="7" y2="14"/>
    <line x1="12" y1="11" x2="15" y2="15.5"/>
    <line x1="15" y1="15.5" x2="18" y2="17"/>
  </svg>
</div></body></html>`

// ICO is a 6-byte header, one 16-byte directory entry per image, then the image
// payloads. Vista+ accepts PNG payloads directly, so no BMP encoding needed.
function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)          // reserved
  header.writeUInt16LE(1, 2)          // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)  // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)            // palette count
    entry.writeUInt8(0, 3)            // reserved
    entry.writeUInt16LE(1, 4)         // colour planes
    entry.writeUInt16LE(32, 6)        // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)])
}

app.on('ready', async () => {
  const outDir = join(__dirname, '..', 'assets', 'icons')
  mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true })

  for (const [name, colors] of Object.entries(THEMES)) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(colors)))
    const full = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), full.toPNG())
    const pngs = ICO_SIZES.map(size => ({ size, data: full.resize({ width: size, height: size }).toPNG() }))
    writeFileSync(join(outDir, `${name}.ico`), buildIco(pngs))
    console.log(`${name}: png 512, ico ${ICO_SIZES.join('/')}`)
  }
  app.exit(0)
})
