import { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, ipcMain, screen, shell, dialog } from 'electron'
import { join, basename, dirname } from 'path'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'

// ── Settings (JSON file, no native deps) ─────────────────────────────────────

const DEFAULTS = {
  clipsFolder: join(app.getPath('videos'), 'Flash'),
  quality: '1080p 60fps',
  bufferLength: 30,
  audioCapture: true,
  autoSave: true,
  notifications: true,
  autoDeleteDays: 0,  // 0 = never
}

type Settings = typeof DEFAULTS

let settings: Settings = { ...DEFAULTS }
let settingsPath = ''

function loadSettings() {
  settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    if (existsSync(settingsPath)) {
      settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath, 'utf8')) }
    }
  } catch { /* use defaults */ }
}

function saveSettings() {
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  } catch (error) {
    console.error('Failed to save settings', error)
  }
}

// "1080p 60fps" → encoder config. Bitrate scales with pixels*fps at ~0.09 bits/px/frame.
function parseQuality(quality: string) {
  const match = /^(\d+)(?:p|K)\s+(\d+)fps$/i.exec(quality.trim())
  const height = match ? (match[1] === '4' ? 2160 : Number(match[1])) : 1080
  const fps = match ? Number(match[2]) : 60
  const bitrateKbps = Math.round((height * (height * 16 / 9) * fps * 0.09) / 1000)
  return { height, fps, bitrateKbps }
}

function applyQuality() {
  const q = parseQuality(settings.quality)
  try { captureAddon?.setQuality?.(q) } catch (error) { console.warn('Could not apply quality', error) }
}

function ensureClipsFolder() {
  if (!existsSync(settings.clipsFolder)) {
    mkdirSync(settings.clipsFolder, { recursive: true })
  }
}

// ── Capture Addon ────────────────────────────────────────────────────────────

type CaptureAddon = {
  initialize(clipsDir: string): { error?: string }
  startReplayBuffer(): boolean
  stopReplayBuffer(): void
  saveClip(): Promise<{ path: string; duration: number }>
  getStatus(): { recording: boolean; bufferSeconds: number; encoder: string }
  setCurrentGame(game: string): void
  setBufferLength(seconds: number): void
  setQuality?(options: { height: number; fps: number; bitrateKbps: number }): void
}

let captureAddon: CaptureAddon | null = null

function loadCaptureAddon(): CaptureAddon | null {
  const addonPath = app.isPackaged
    ? join(process.resourcesPath, 'flash_capture.node')
    : join(__dirname, '../../../../packages/flash-capture/build/Release/flash_capture.node')
  try { return require(addonPath) as CaptureAddon }
  catch (error) { console.warn(`Flash capture addon unavailable at ${addonPath}`, error); return null }
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let notificationWindow: BrowserWindow | null = null
let isRecording = false
let currentGame: string | null = null
let gameDetectorInterval: ReturnType<typeof setInterval> | null = null

// ── Clip Management ──────────────────────────────────────────────────────────

interface ClipInfo {
  id: string
  title: string
  game: string
  duration: string
  durationSec: number
  filePath: string
  size: number
  createdAt: number
}

const sidecarPath = (clipPath: string) => clipPath.replace(/\.mp4$/i, '.json')

function readSidecar(clipPath: string): { duration: number; game: string } | null {
  try { return JSON.parse(readFileSync(sidecarPath(clipPath), 'utf8')) } catch { return null }
}

function scanClips(): ClipInfo[] {
  const clips: ClipInfo[] = []
  const folder = settings.clipsFolder
  if (!existsSync(folder)) return clips

  // Scan for MP4 files in clips folder and game subfolders
  const scanDir = (dir: string, game: string) => {
    try {
      for (const file of readdirSync(dir)) {
        const filePath = join(dir, file)
        const stat = statSync(filePath)
        if (stat.isDirectory()) {
          scanDir(filePath, file) // subfolder name = game name
        } else if (file.endsWith('.mp4')) {
          const name = basename(file, '.mp4')
          // Real duration comes from the sidecar written at save time; fall back to a
          // size estimate (~2MB/s at 1080p60) for clips saved before sidecars existed.
          const estimatedSec = readSidecar(filePath)?.duration
            ?? Math.max(1, Math.round(stat.size / (2 * 1024 * 1024)))
          const minutes = Math.floor(estimatedSec / 60)
          const seconds = estimatedSec % 60
          clips.push({
            id: filePath,
            title: name.replace(/_/g, ' ').replace(/-/g, ' '),
            game: game || 'Unknown',
            duration: `${minutes}:${String(seconds).padStart(2, '0')}`,
            durationSec: estimatedSec,
            filePath,
            size: stat.size,
            createdAt: stat.birthtimeMs,
          })
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  scanDir(folder, '')
  // Newest first
  clips.sort((a, b) => b.createdAt - a.createdAt)
  return clips
}

function deleteClip(filePath: string): boolean {
  // Only delete inside the clips folder — filePath comes from the renderer.
  if (!filePath.startsWith(settings.clipsFolder)) return false
  try { unlinkSync(filePath) } catch { return false }
  try { unlinkSync(sidecarPath(filePath)) } catch { /* no sidecar */ }
  return true
}

function pruneOldClips() {
  if (!settings.autoDeleteDays) return
  const cutoff = Date.now() - settings.autoDeleteDays * 86400000
  for (const clip of scanClips()) if (clip.createdAt < cutoff) deleteClip(clip.filePath)
}

// Both the F8 hotkey and the renderer's save button land here.
function onClipSaved(clip: { path: string; duration: number }) {
  try {
    writeFileSync(sidecarPath(clip.path),
      JSON.stringify({ duration: clip.duration, game: currentGame ?? 'Unknown' }))
  } catch { /* sidecar is an optimisation, not required */ }
  showClipNotification(clip.duration)
  playClipSound()
  mainWindow?.webContents.send('clip-saved-refresh')
}

function getStorageUsage(): { used: number; clips: number } {
  const clips = scanClips()
  const used = clips.reduce((sum, c) => sum + c.size, 0)
  return { used, clips: clips.length }
}

// ── Game Detection ────────────────────────────────────────────────────────────

const GAME_DB: Record<string, string> = {}

function loadGameDb() {
  try {
    const dbPath = join(__dirname, '../../../../packages/flash-detector/src/games.json')
    const data = require(dbPath)
    for (const entry of data.games) {
      GAME_DB[entry.processName.toLowerCase()] = entry.displayName
    }
  } catch { /* Game DB not found */ }
}

function detectCurrentGame(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], (error, stdout) => {
      if (error) { resolve(null); return }
      for (const line of stdout.split('\n')) {
        const match = line.match(/"([^"]+)"/)
        if (!match) continue
        const gameName = GAME_DB[match[1].toLowerCase()]
        if (gameName) { resolve(gameName); return }
      }
      resolve(null)
    })
  })
}

function startGameDetection() {
  loadGameDb()
  const poll = async () => {
    const game = await detectCurrentGame()
    if (game !== currentGame) {
      currentGame = game
      if (game) captureAddon?.setCurrentGame(game)
      mainWindow?.webContents.send('game-detected', game)
    }
  }
  poll()
  gameDetectorInterval = setInterval(poll, 3000)
}

function stopGameDetection() {
  if (gameDetectorInterval) {
    clearInterval(gameDetectorInterval)
    gameDetectorInterval = null
  }
}

// ── Notification Popup ────────────────────────────────────────────────────────

function showClipNotification(durationSeconds: number) {
  if (!settings.notifications) return

  const display = screen.getPrimaryDisplay()
  const { x, y } = display.workArea

  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.close()
  }

  notificationWindow = new BrowserWindow({
    width: 280, height: 72,
    x: x + 16, y: y + 16,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false, show: false,
  })

  notificationWindow.setIgnoreMouseEvents(true, { forward: true })

  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  const durationStr = `${minutes}:${String(seconds).padStart(2, '0')}`

  const html = `<!DOCTYPE html><html><head><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', 'Segoe UI', sans-serif; background: transparent; overflow: hidden; }
    .toast { display: flex; align-items: center; gap: 12px; padding: 14px 18px;
      background: rgba(10, 0, 8, 0.92); border: 1px solid rgba(232, 25, 44, 0.3);
      border-radius: 12px; backdrop-filter: blur(16px);
      animation: slideIn 0.3s ease-out, fadeOut 0.4s ease-in 2.6s forwards; }
    .icon { width: 36px; height: 36px; border-radius: 8px; background: rgba(232, 25, 44, 0.15);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .icon svg { color: #e8192c; }
    .text h3 { font-size: 13px; font-weight: 600; color: #f0f0f0; margin-bottom: 2px; }
    .text p { font-size: 11px; color: #666; }
    .text .dur { color: #e8192c; font-weight: 500; }
    @keyframes slideIn { from { transform: translateX(-20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
  </style></head><body>
    <div class="toast">
      <div class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="14" cy="3.5" r="2"/><line x1="14" y1="5.5" x2="12" y2="11"/>
        <line x1="12" y1="8" x2="8.5" y2="6.5"/><line x1="12" y1="8" x2="16" y2="6"/>
        <line x1="12" y1="11" x2="9" y2="16"/><line x1="9" y1="16" x2="7" y2="14"/>
        <line x1="12" y1="11" x2="15" y2="15.5"/><line x1="15" y1="15.5" x2="18" y2="17"/>
      </svg></div>
      <div class="text"><h3>Clipped!</h3><p><span class="dur">${durationStr}</span> saved to library</p></div>
    </div>
  </body></html>`

  notificationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  notificationWindow.once('ready-to-show', () => notificationWindow?.show())
  setTimeout(() => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.close()
      notificationWindow = null
    }
  }, 3200)
}

function playClipSound() {
  if (!settings.notifications) return
  const soundPath = join(__dirname, '../../../../assets/sounds/clip-saved.wav')
  mainWindow?.webContents.send('play-clip-sound', soundPath)
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = join(__dirname, '../../../../assets/icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  updateTrayMenu()
  tray.setToolTip('Flash — Game Clipper')
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

function updateTrayMenu() {
  if (!tray) return
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Flash', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: isRecording ? 'Stop Replay Buffer' : 'Start Replay Buffer', click: () => {
      if (isRecording) {
        captureAddon?.stopReplayBuffer()
        isRecording = false
      } else {
        isRecording = captureAddon?.startReplayBuffer() ?? false
      }
      mainWindow?.webContents.send('recording-state', isRecording)
      updateTrayMenu()
    }},
    { type: 'separator' },
    { label: 'Open Clips Folder', click: () => shell.openPath(settings.clipsFolder) },
    { label: 'Settings', click: () => { mainWindow?.show(); mainWindow?.webContents.send('navigate', 'Settings') } },
    { type: 'separator' },
    { label: 'Quit Flash', click: () => app.quit() },
  ])
  tray.setContextMenu(contextMenu)
}

// ── Main Window ───────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 900, minHeight: 600,
    frame: false, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c000c', symbolColor: '#666', height: 32 },
    backgroundColor: '#060006',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    icon: join(__dirname, '../../../../assets/icon.png'),
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (!(app as any).isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function setupIPC() {
  // ── Capture ──
  ipcMain.handle('capture-start-replay', () => {
    if (!captureAddon) return false
    try {
      const started = captureAddon.startReplayBuffer()
      isRecording = started
      updateTrayMenu()
      mainWindow?.webContents.send('recording-state', isRecording)
      return started
    } catch (error) {
      console.error('Failed to start replay buffer', error)
      return false
    }
  })

  ipcMain.handle('capture-stop-replay', () => {
    try { captureAddon?.stopReplayBuffer() } catch { /* ignore */ }
    isRecording = false
    updateTrayMenu()
    mainWindow?.webContents.send('recording-state', isRecording)
  })

  ipcMain.handle('capture-save-clip', async () => {
    if (!captureAddon) return { error: 'Capture engine not available' }
    if (!isRecording) return { error: 'Replay buffer not running — start recording first' }
    try {
      const clip = await captureAddon.saveClip()
      onClipSaved(clip)
      return { path: clip.path, duration: clip.duration }
    } catch (error: any) {
      console.error('Failed to save clip', error)
      return { error: error.message || 'Failed to save clip' }
    }
  })

  ipcMain.handle('capture-status', () => {
    if (!captureAddon) return { recording: false, bufferSeconds: settings.bufferLength, encoder: 'none', available: false }
    try {
      const status = captureAddon.getStatus()
      return { ...status, available: true }
    } catch {
      return { recording: isRecording, bufferSeconds: settings.bufferLength, encoder: 'unknown', available: true }
    }
  })

  ipcMain.handle('capture-set-buffer-length', (_event, seconds: number) => {
    settings.bufferLength = seconds
    saveSettings()
    try { captureAddon?.setBufferLength(seconds) } catch { /* ignore */ }
  })

  // ── Clips ──
  ipcMain.handle('get-clips', () => scanClips())
  ipcMain.handle('get-storage', () => getStorageUsage())
  ipcMain.handle('delete-clip', (_event, filePath: string) => deleteClip(filePath))
  ipcMain.handle('open-clip', (_event, filePath: string) => {
    shell.openPath(filePath)
  })
  ipcMain.handle('open-clips-folder', () => {
    shell.openPath(settings.clipsFolder)
  })
  ipcMain.handle('show-clip-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // ── Settings ──
  ipcMain.handle('get-settings', () => ({ ...settings }))
  ipcMain.handle('set-settings', (_event, partial: Partial<Settings>) => {
    Object.assign(settings, partial)
    saveSettings()
    if (partial.bufferLength !== undefined) {
      try { captureAddon?.setBufferLength(partial.bufferLength) } catch { /* ignore */ }
    }
    if (partial.quality !== undefined) applyQuality()
    if (partial.autoDeleteDays !== undefined) pruneOldClips()
    return { ...settings }
  })
  ipcMain.handle('pick-clips-folder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: settings.clipsFolder,
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    settings.clipsFolder = result.filePaths[0]
    saveSettings()
    ensureClipsFolder()
    return settings.clipsFolder
  })

  // ── Recording toggle ──
  ipcMain.on('toggle-recording', () => {
    if (isRecording) {
      try { captureAddon?.stopReplayBuffer() } catch { /* ignore */ }
      isRecording = false
    } else {
      isRecording = captureAddon?.startReplayBuffer() ?? false
    }
    mainWindow?.webContents.send('recording-state', isRecording)
    updateTrayMenu()
  })

  ipcMain.handle('get-recording-state', () => isRecording)
  ipcMain.handle('get-current-game', () => currentGame)
  ipcMain.handle('has-capture-addon', () => !!captureAddon)

  // Window controls
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
}

// ── Hotkeys ───────────────────────────────────────────────────────────────────

function registerHotkeys() {
  globalShortcut.register('F8', () => {
    mainWindow?.webContents.send('hotkey-clip')
    if (!captureAddon || !isRecording) {
      // Don't crash — just ignore if not recording
      console.log('F8 pressed but replay buffer not active')
      return
    }
    captureAddon.saveClip()
      .then(onClipSaved)
      .catch((error) => console.error('Failed to save clip via F8', error))
  })
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────

app.on('ready', () => {
  loadSettings()
  ensureClipsFolder()

  pruneOldClips()

  captureAddon = loadCaptureAddon()
  if (captureAddon) {
    const status = captureAddon.initialize(settings.clipsFolder)
    if (status.error) console.warn('Capture init warning:', status.error)
    // Auto-start replay buffer
    captureAddon.setBufferLength(settings.bufferLength)
    applyQuality()
    try {
      isRecording = captureAddon.startReplayBuffer()
      if (isRecording) console.log('Replay buffer started automatically')
      else console.warn('Replay buffer failed to start')
    } catch (error) {
      console.warn('Could not auto-start replay buffer:', error)
    }
  }

  createWindow()
  createTray()
  setupIPC()
  registerHotkeys()
  startGameDetection()
})

app.on('window-all-closed', () => { /* live in tray */ })
app.on('before-quit', () => { (app as any).isQuitting = true })
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopGameDetection()
  try { captureAddon?.stopReplayBuffer() } catch { /* ignore */ }
})
app.on('activate', () => { if (!mainWindow) createWindow() })
