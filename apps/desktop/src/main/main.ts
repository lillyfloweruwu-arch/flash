import { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, ipcMain, screen } from 'electron'
import { join } from 'path'
import { execFile } from 'child_process'

type CaptureAddon = {
  initialize(clipsDir: string): { error?: string }
  startReplayBuffer(): boolean
  stopReplayBuffer(): void
  saveClip(): Promise<{ path: string; duration: number }>
  getStatus(): unknown
  setCurrentGame(game: string): void
  setBufferLength(seconds: number): void
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

// ── Game Detection ────────────────────────────────────────────────────────────

// Inline game detection (avoids importing TS module from main process)
const GAME_DB: Record<string, string> = {}

function loadGameDb() {
  try {
    const dbPath = join(__dirname, '../../../../packages/flash-detector/src/games.json')
    const data = require(dbPath)
    for (const entry of data.games) {
      GAME_DB[entry.processName.toLowerCase()] = entry.displayName
    }
  } catch {
    // Game DB not found — detection disabled
  }
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

  poll() // immediate
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
  const display = screen.getPrimaryDisplay()
  const { x, y } = display.workArea

  // Close existing notification if any
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.close()
  }

  notificationWindow = new BrowserWindow({
    width: 280,
    height: 72,
    x: x + 16,
    y: y + 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
    },
  })

  // Make click-through on Windows
  notificationWindow.setIgnoreMouseEvents(true, { forward: true })

  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  const durationStr = minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}`
    : `0:${String(seconds).padStart(2, '0')}`

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Inter', 'Segoe UI', sans-serif;
          background: transparent;
          overflow: hidden;
          -webkit-app-region: no-drag;
        }
        .toast {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 18px;
          background: rgba(10, 0, 8, 0.92);
          border: 1px solid rgba(232, 25, 44, 0.3);
          border-radius: 12px;
          backdrop-filter: blur(16px);
          animation: slideIn 0.3s ease-out, fadeOut 0.4s ease-in 2.6s forwards;
        }
        .icon {
          width: 36px;
          height: 36px;
          border-radius: 8px;
          background: rgba(232, 25, 44, 0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .icon svg { color: #e8192c; }
        .text h3 {
          font-size: 13px;
          font-weight: 600;
          color: #f0f0f0;
          margin-bottom: 2px;
        }
        .text p {
          font-size: 11px;
          color: #666;
        }
        .text .duration { color: #e8192c; font-weight: 500; }
        @keyframes slideIn {
          from { transform: translateX(-20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      </style>
    </head>
    <body>
      <div class="toast">
        <div class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="14" cy="3.5" r="2"/>
            <line x1="14" y1="5.5" x2="12" y2="11"/>
            <line x1="12" y1="8" x2="8.5" y2="6.5"/>
            <line x1="12" y1="8" x2="16" y2="6"/>
            <line x1="12" y1="11" x2="9" y2="16"/>
            <line x1="9" y1="16" x2="7" y2="14"/>
            <line x1="12" y1="11" x2="15" y2="15.5"/>
            <line x1="15" y1="15.5" x2="18" y2="17"/>
          </svg>
        </div>
        <div class="text">
          <h3>Clipped!</h3>
          <p><span class="duration">${durationStr}</span> saved to library</p>
        </div>
      </div>
    </body>
    </html>
  `

  notificationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  notificationWindow.once('ready-to-show', () => {
    notificationWindow?.show()
  })

  // Auto-close after 3 seconds
  setTimeout(() => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.close()
      notificationWindow = null
    }
  }, 3200)
}

// ── Play notification sound ───────────────────────────────────────────────────

function playClipSound() {
  // Play custom WAV via a hidden renderer (Electron has no direct audio API)
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

  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function updateTrayMenu() {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Flash',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      click: () => {
        isRecording = !isRecording
        mainWindow?.webContents.send('recording-state', isRecording)
        updateTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        mainWindow?.show()
        mainWindow?.webContents.send('navigate', 'Settings')
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Flash',
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
}

// ── Main Window ───────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0c000c',
      symbolColor: '#666',
      height: 32,
    },
    backgroundColor: '#060006',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: join(__dirname, '../../../../assets/icon.png'),
  })

  // Dev or production
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!(app as any).isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle('capture-start-replay', () => {
    if (!captureAddon) throw new Error('Flash capture addon is not available')
    const started = captureAddon.startReplayBuffer()
    isRecording = started
    updateTrayMenu()
    return started
  })
  ipcMain.handle('capture-stop-replay', () => {
    captureAddon?.stopReplayBuffer()
    isRecording = false
    updateTrayMenu()
  })
  ipcMain.handle('capture-save-clip', async () => {
    if (!captureAddon) throw new Error('Flash capture addon is not available')
    const clip = await captureAddon.saveClip()
    showClipNotification(clip.duration)
    playClipSound()
    return clip
  })
  ipcMain.handle('capture-status', () => captureAddon?.getStatus() ?? { recording: false, encoder: 'none' })
  ipcMain.handle('capture-set-buffer-length', (_event, seconds: number) => captureAddon?.setBufferLength(seconds))

  // Clip saved — show notification
  ipcMain.on('clip-saved', (_event, durationSeconds: number) => {
    showClipNotification(durationSeconds)
    playClipSound()
  })

  // Recording state toggle
  ipcMain.on('toggle-recording', () => {
    isRecording = !isRecording
    mainWindow?.webContents.send('recording-state', isRecording)
    updateTrayMenu()
  })

  // Get recording state
  ipcMain.handle('get-recording-state', () => isRecording)

  // Get current detected game
  ipcMain.handle('get-current-game', () => currentGame)

  // Window controls
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on('window-close', () => mainWindow?.close())
}

// ── Hotkeys ───────────────────────────────────────────────────────────────────

function registerHotkeys() {
  // F8 — save clip
  globalShortcut.register('F8', () => {
    mainWindow?.webContents.send('hotkey-clip')
    if (captureAddon) {
      void captureAddon.saveClip().then((clip) => {
        showClipNotification(clip.duration)
        playClipSound()
      }).catch((error) => console.error('Failed to save clip', error))
    }
  })
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────

app.on('ready', () => {
  captureAddon = loadCaptureAddon()
  if (captureAddon) {
    const status = captureAddon.initialize(join(app.getPath('videos'), 'Flash'))
    if (status.error) console.warn(status.error)
  }
  createWindow()
  createTray()
  setupIPC()
  registerHotkeys()
  startGameDetection()
})

app.on('window-all-closed', () => {
  // Don't quit — we live in the tray
})

app.on('before-quit', () => {
  (app as any).isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopGameDetection()
})

app.on('activate', () => {
  if (!mainWindow) {
    createWindow()
  }
})
