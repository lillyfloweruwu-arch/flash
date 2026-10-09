// Run with the local Electron executable. This mounts the real React controls
// in an isolated, hidden window and uses Chromium's native keyboard events.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const ts = require('../../apps/desktop/node_modules/typescript')
const assert = require('node:assert/strict')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-controls-'))
app.setPath('userData', scratch)
app.commandLine.appendSwitch('force-prefers-reduced-motion')
const loadTypeScript = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, file)
require.extensions['.ts'] = loadTypeScript
require.extensions['.tsx'] = loadTypeScript

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 900, height: 600, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  })
  ipcMain.handle('probe-key', async (_event, key, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    await new Promise(resolve => setTimeout(resolve, 35))
  })
  const renderer = path.join(__dirname, 'renderer-controls-page.js')
  const done = new Promise((resolve, reject) => {
    ipcMain.once('probe-result', (_event, error) => error ? reject(new Error(error)) : resolve())
  })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;background:#0a0a0b;color:#f2f3f5;font:13px 'Segoe UI'}
    button{color:inherit}.relative{position:relative}.absolute{position:absolute}.fixed{position:fixed}.inset-0{inset:0}.flex{display:flex}.items-center{align-items:center}.justify-center{justify-content:center}.w-full{width:100%}.truncate{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.flex-1{flex:1}
    :root{--fg:#f2f3f5;--muted:#9aa0ab;--panel:#121316;--edge:#2a2d34;--line:#555;--hover:#222}
    </style><button id="opener">Delete fixture</button><div id="root"></div><script>require(${JSON.stringify(renderer)})</script>`)}`)
  window.webContents.focus()
  await done
  console.log('PASS: Chromium Enter on Cancel preserves fixture; Enter/Space delete once; Escape, Tab containment and focus restoration')
  console.log('PASS: 60-option dropdown at 900x600 and 150% zoom scrolls to 300; arrows do not reach Watch')

  const { THEMES } = require('../../apps/desktop/src/shared/themes.ts')
  const { toastHtml, overlayHtml, cornerBounds } = require('../../apps/desktop/src/shared/windowTemplates.ts')
  const font = 'data:font/woff2;base64,' + fs.readFileSync(path.join(__dirname, '../../apps/desktop/node_modules/@fontsource-variable/antonio/files/antonio-latin-wght-normal.woff2')).toString('base64')
  for (const theme of Object.keys(THEMES)) {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toastHtml(theme, font, 125))}`)
    const result = await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.load('600 26px Antonio')
      const title = document.querySelector('h3'), surface = document.querySelector('.surface')
      return {font: document.fonts.check('600 26px Antonio'), animation: getComputedStyle(surface).animationName, fits: title.scrollWidth <= title.clientWidth}
    })()`)
    assert.deepEqual(result, { font: true, animation: 'none', fits: true })
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(theme, font))}`)
    await window.webContents.executeJavaScript(`window.setState({visible:true,recording:true,saving:true,game:'A very long game name repeated for overflow testing'})`)
    const animation = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.dot')).animationName`)
    assert.equal(animation, 'none')
  }
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const bounds = cornerBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, corner, 280, 72)
    assert(bounds.x >= -1920 && bounds.x + bounds.width <= 0 && bounds.y >= 0 && bounds.y + bounds.height <= 1080)
  }
  console.log('PASS: six toast/overlay themes load bundled Antonio, reduced motion disables animations, all corners stay on target')
  window.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
app.on('will-quit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* Chromium may still be closing its cache. */ } })
