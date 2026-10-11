// Runs actual main-process functions with isolated services and temporary files.
// No app startup, screen capture, hotkey registration or user settings are used.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { EventEmitter } = require('node:events')
const { runInNewContext } = require('node:vm')
const ts = require('../../apps/desktop/node_modules/typescript')
const source = fs.readFileSync(path.join(__dirname, '../../apps/desktop/src/main/main.ts'), 'utf8')
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
function functions(names, context) {
  const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  assert.equal(selected.length, names.length)
  runInNewContext(ts.transpileModule(selected.map(node => node.getText(tree)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context)
  return context
}

;(async () => {
  const { byteRange } = await import('../../apps/desktop/src/shared/byteRange.ts')
  const { clipPathFromUrl } = await import('../../apps/desktop/src/shared/platform.ts')
  const { clipUrl } = await import('../../apps/desktop/src/shared/editor.ts')
  const { isInsideRoot } = await import('../../apps/desktop/src/shared/clipsRoot.ts')
  const { writeSidecar, readSidecar } = await import('../../apps/desktop/src/shared/clipFiles.ts')
  const { gameFolderName, firstFreeName, clipTimestamp } = await import('../../apps/desktop/src/shared/clipPath.ts')
  const { cornerBounds, toastHtml, overlayHtml } = await import('../../apps/desktop/src/shared/windowTemplates.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-boundaries-'))
  const messages = []
  const context = {
    console: { ...console, warn() {}, error() {} }, process, ...fs, ...path, Blob, Response,
    settings: { clipsFolder: dir, notifications: true, overlay: true, overlayPosition: 'bottom-right', theme: 'blood', displayId: 99 },
    currentGame: 'Game A', isRecording: true, writeSidecar, readSidecar, gameFolderName, firstFreeName, clipTimestamp,
    mainWindow: { webContents: { send: (...args) => messages.push(args) }, isVisible: () => false, isMinimized: () => false },
    captureAddon: {
      getStatus: () => ({ recording: true }),
      saveScreenshot: async file => fs.writeFileSync(file, 'PNG fixture'),
      saveClip: async () => ({ path: path.join(dir, 'Game B', 'clip.mp4'), duration: 4, game: 'Game B' }),
      listDisplays: () => [{ id: 2, isPrimary: true }],
    },
    clipboard: { write: async () => { throw new Error('injected clipboard rejection') } },
    ClipboardItem: class { constructor(data) { this.data = data } },
    playClipSound() {}, showClipNotification() {}, updateOverlay() {}, setRecordingState() {},
    checkDiskSpace: async () => { context.currentGame = 'Game B'; return null },
  }
  try {
    functions(['runSaveScreenshot', 'runSaveClip', 'onClipSaved', 'availableDisplay', 'playbackVisible'], context)
    await context.runSaveScreenshot()
    assert.equal(fs.readdirSync(path.join(dir, 'Game A')).filter(name => name.endsWith('.png')).length, 1)
    assert.equal(messages.some(([channel]) => channel === 'clip-saved-refresh'), true)
    assert.match(messages.find(([channel]) => channel === 'clip-save-state')[1].error, /saved to library/)
    fs.mkdirSync(path.join(dir, 'Game B'))
    const saved = await context.runSaveClip()
    assert.equal(readSidecar(saved.path).game, 'Game B')
    assert.equal(path.basename(path.dirname(saved.path)), 'Game B')
    assert.equal(context.availableDisplay(99), 2)
    assert.equal(context.availableDisplay(2), 2)
    assert.equal(context.playbackVisible(), false)
    context.mainWindow.isVisible = () => true
    context.mainWindow.isMinimized = () => true
    assert.equal(context.playbackVisible(), false)
    context.mainWindow.isMinimized = () => false
    assert.equal(context.playbackVisible(), true)
    console.log('PASS: clipboard rejection refreshes saved PNG; post-disk-check game identity agrees; display fallback and hidden/minimized visibility')

    let handler
    Object.assign(context, { byteRange, clipPathFromUrl, isInsideRoot, Readable: require('node:stream').Readable,
      protocol: { handle: (_scheme, callback) => { handler = callback } },
      isInsideClips: file => file.startsWith(dir), resource: () => path.join(dir, 'sound.wav'),
    })
    functions(['registerClipProtocol'], context)
    context.registerClipProtocol()
    const media = path.join(dir, 'range ü.mp4')
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
    fs.writeFileSync(media, bytes)
    // The renderer's own URL builder, so the probe follows it on every platform:
    // a POSIX path has no drive letter and keeps its slashes.
    const url = clipUrl(media)
    for (const [range, status, start, end] of [[null, 200, 0, 1000], ['bytes=100-', 206, 100, 1000], ['bytes=-100', 206, 900, 1000], ['bytes=200-299', 206, 200, 300]]) {
      const response = await handler({ url, headers: new Headers(range ? { Range: range } : {}) })
      assert.equal(response.status, status)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end))
    }
    for (const range of ['bytes=-0', 'bytes=1000-', 'bytes=2-1', 'bytes=1-2,4-5', 'broken']) {
      const response = await handler({ url, headers: new Headers({ Range: range }) })
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('Content-Range'), 'bytes */1000')
    }
    fs.writeFileSync(media, '')
    const empty = await handler({ url, headers: new Headers() })
    assert.equal(empty.status, 200)
    assert.equal((await empty.arrayBuffer()).byteLength, 0)
    console.log('PASS: actual protocol returns byte-exact full/open/suffix/explicit responses, Unicode paths, empty 200 and invalid 416')

    const timers = []
    const windows = []
    class FakeWindow extends EventEmitter {
      constructor() { super(); this.webContents = { executeJavaScript: script => { this.script = script; return Promise.resolve() } }; windows.push(this) }
      isDestroyed() { return !!this.destroyed }
      close() { this.destroyed = true; this.emit('closed') }
      setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {} setBounds() {}
      showInactive() { this.shown = true }
      loadURL(url) { this.url = url }
    }
    Object.assign(context, { BrowserWindow: FakeWindow, notificationWindow: null, overlayWindow: null, overlaySaving: false,
      antonioFont: () => 'data:font/woff2;base64,fixture', toastHtml, overlayHtml, cornerBounds,
      captureDisplay: () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }),
      setTimeout: callback => { timers.push(callback); return timers.length }, clearTimeout() {},
    })
    functions(['showClipNotification', 'createOverlay', 'overlayBounds', 'updateOverlay', 'destroyOverlay'], context)
    context.showClipNotification(3)
    const first = windows.at(-1)
    first.emit('ready-to-show')
    context.showClipNotification(5)
    const second = windows.at(-1)
    second.emit('ready-to-show')
    timers[0]()
    assert.equal(second.isDestroyed(), false)
    assert.equal(second.shown, true)
    context.updateOverlay(true)
    const overlay = windows.at(-1)
    overlay.emit('ready-to-show')
    assert.match(overlay.script, /"saving":true/)
    context.updateOverlay()
    assert.match(overlay.script, /"saving":true/)
    context.updateOverlay(false)
    assert.match(overlay.script, /"saving":false/)
    let trayUpdates = 0, overlayUpdates = 0
    context.updateTrayMenu = () => trayUpdates++
    context.updateOverlay = () => overlayUpdates++
    functions(['setRecordingState'], context)
    context.setRecordingState(false); context.setRecordingState(true)
    assert.equal(trayUpdates, 2); assert.equal(overlayUpdates, 2)
    assert.deepEqual(messages.filter(([channel]) => channel === 'recording-state').map(([, value]) => value), [false, true])
    console.log('PASS: earlier toast timer cannot close its successor; overlay retains saving through readiness; recording surfaces agree')

    const registered = new Set()
    Object.assign(context, { hotkeyStatus: {}, hotkeyRegistered: false,
      globalShortcut: { unregisterAll: () => registered.clear(), register: key => {
        if (key === 'F10' || registered.has(key)) return false
        registered.add(key)
        return true
      } },
    })
    Object.assign(context.settings, { hotkey: 'F8', hotkeyShort: 'F8', screenshotHotkey: 'F10' })
    functions(['claim', 'registerHotkeys'], context)
    context.registerHotkeys()
    assert.deepEqual(context.hotkeyStatus, { clip: true, short: false, screenshot: false })
    Object.assign(context.settings, { hotkeyShort: 'Shift+F8', screenshotHotkey: 'F9' })
    context.registerHotkeys()
    assert.deepEqual(context.hotkeyStatus, { clip: true, short: true, screenshot: true })
    console.log('PASS: duplicate and externally conflicted secondary hotkeys fail independently; rebinding refreshes all three')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
