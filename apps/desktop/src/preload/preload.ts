import { contextBridge, ipcRenderer } from 'electron'

export interface ClipInfo {
  id: string
  title: string
  game: string
  duration: string
  durationSec: number
  filePath: string
  size: number
  createdAt: number
}

export interface Settings {
  clipsFolder: string
  quality: string
  bufferLength: number
  audioCapture: boolean
  autoSave: boolean
  notifications: boolean
  autoDeleteDays: number
}

contextBridge.exposeInMainWorld('flash', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // Recording
  toggleRecording: () => ipcRenderer.send('toggle-recording'),
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  onRecordingState: (callback: (state: boolean) => void) => {
    ipcRenderer.on('recording-state', (_event, state) => callback(state))
  },
  hasCaptureAddon: () => ipcRenderer.invoke('has-capture-addon'),

  // Clips
  getClips: () => ipcRenderer.invoke('get-clips'),
  getStorage: () => ipcRenderer.invoke('get-storage'),
  deleteClip: (filePath: string) => ipcRenderer.invoke('delete-clip', filePath),
  openClip: (filePath: string) => ipcRenderer.invoke('open-clip', filePath),
  openClipsFolder: () => ipcRenderer.invoke('open-clips-folder'),
  showClipInFolder: (filePath: string) => ipcRenderer.invoke('show-clip-in-folder', filePath),
  onHotkeyClip: (callback: () => void) => {
    ipcRenderer.on('hotkey-clip', () => callback())
  },
  onClipSavedRefresh: (callback: () => void) => {
    ipcRenderer.on('clip-saved-refresh', () => callback())
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (partial: Partial<Settings>) => ipcRenderer.invoke('set-settings', partial),
  pickClipsFolder: () => ipcRenderer.invoke('pick-clips-folder'),

  // Navigation
  onNavigate: (callback: (page: string) => void) => {
    ipcRenderer.on('navigate', (_event, page) => callback(page))
  },

  // Sound
  onPlayClipSound: (callback: (soundPath: string) => void) => {
    ipcRenderer.on('play-clip-sound', (_event, soundPath: string) => callback(soundPath))
  },

  // Game detection
  getCurrentGame: () => ipcRenderer.invoke('get-current-game'),
  onGameDetected: (callback: (game: string | null) => void) => {
    ipcRenderer.on('game-detected', (_event, game) => callback(game))
  },

  // Capture engine
  capture: {
    startReplayBuffer: () => ipcRenderer.invoke('capture-start-replay'),
    stopReplayBuffer: () => ipcRenderer.invoke('capture-stop-replay'),
    saveClip: () => ipcRenderer.invoke('capture-save-clip'),
    getStatus: () => ipcRenderer.invoke('capture-status'),
    setBufferLength: (seconds: number) => ipcRenderer.invoke('capture-set-buffer-length', seconds),
  },
})

export type FlashAPI = {
  minimize: () => void
  maximize: () => void
  close: () => void
  toggleRecording: () => void
  getRecordingState: () => Promise<boolean>
  onRecordingState: (callback: (state: boolean) => void) => void
  hasCaptureAddon: () => Promise<boolean>
  getClips: () => Promise<ClipInfo[]>
  getStorage: () => Promise<{ used: number; clips: number }>
  deleteClip: (filePath: string) => Promise<boolean>
  openClip: (filePath: string) => Promise<void>
  openClipsFolder: () => Promise<void>
  showClipInFolder: (filePath: string) => Promise<void>
  onHotkeyClip: (callback: () => void) => void
  onClipSavedRefresh: (callback: () => void) => void
  getSettings: () => Promise<Settings>
  setSettings: (partial: Partial<Settings>) => Promise<Settings>
  pickClipsFolder: () => Promise<string | null>
  onNavigate: (callback: (page: string) => void) => void
  onPlayClipSound: (callback: (soundPath: string) => void) => void
  getCurrentGame: () => Promise<string | null>
  onGameDetected: (callback: (game: string | null) => void) => void
  capture: {
    startReplayBuffer: () => Promise<boolean>
    stopReplayBuffer: () => Promise<void>
    saveClip: () => Promise<{ path?: string; duration?: number; error?: string }>
    getStatus: () => Promise<{ recording: boolean; bufferSeconds: number; encoder: string; available: boolean }>
    setBufferLength: (seconds: number) => Promise<void>
  }
}
