import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

function subscribe<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: T) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

export interface ClipInfo {
  id: string
  title: string
  game: string
  kind: 'clip' | 'shot'
  duration: string
  durationSec: number
  filePath: string
  size: number
  createdAt: number
  starred: boolean
}

export interface AutostartState {
  enabled: boolean
  managedByWindows: boolean
  supported: boolean
  error?: string
}

export interface Settings {
  clipsFolder: string
  theme: string
  hotkey: string
  hotkeyShort: string
  screenshotHotkey: string
  shortClipSeconds: number
  voiceEnabled: boolean
  voicePhrase: string
  voiceRawFloor: number
  voiceCooldownMs: number
  displayId: number
  overlay: boolean
  overlayPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  quality: string
  bufferLength: number
  audioCapture: boolean
  autoSave: boolean
  notifications: boolean
  autoDeleteDays: number
  perGame: Record<string, { quality?: string; bufferLength?: number }>
}

contextBridge.exposeInMainWorld('flash', {
  platform: process.platform,
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  getPlaybackVisibility: () => ipcRenderer.invoke('playback-visibility'),
  onPlaybackVisibility: (callback: (visible: boolean) => void) => subscribe('playback-visibility', callback),

  // Recording
  toggleRecording: () => ipcRenderer.send('toggle-recording'),
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  onRecordingState: (callback: (state: boolean) => void) => {
    return subscribe('recording-state', callback)
  },
  hasCaptureAddon: () => ipcRenderer.invoke('has-capture-addon'),

  // Clips
  getClips: () => ipcRenderer.invoke('get-clips'),
  getStorage: () => ipcRenderer.invoke('get-storage'),
  deleteClip: (filePath: string) => ipcRenderer.invoke('delete-clip', filePath),
  renameClip: (filePath: string, name: string) => ipcRenderer.invoke('rename-clip', filePath, name),
  setClipStarred: (filePath: string, starred: boolean) =>
    ipcRenderer.invoke('set-clip-starred', filePath, starred),
  openClip: (filePath: string) => ipcRenderer.invoke('open-clip', filePath),
  openClipsFolder: () => ipcRenderer.invoke('open-clips-folder'),
  showClipInFolder: (filePath: string) => ipcRenderer.invoke('show-clip-in-folder', filePath),
  startClipDrag: (filePaths: string | string[]) => ipcRenderer.send(
    'start-clip-drag', Array.isArray(filePaths) ? filePaths : [filePaths]),
  moveClips: (filePaths: string[], game: string) => ipcRenderer.invoke('move-clips', filePaths, game),
  copyClipFile: (filePath: string) => ipcRenderer.invoke('copy-clip-file', filePath),
  readThumbnail: (filePath: string) => ipcRenderer.invoke('thumbnail-read', filePath),
  writeThumbnail: (filePath: string, bytes: Uint8Array) => ipcRenderer.invoke('thumbnail-write', filePath, bytes),
  saveClipFrame: (filePath: string, playheadSeconds: number, bytes: Uint8Array) =>
    ipcRenderer.invoke('save-clip-frame', filePath, playheadSeconds, bytes),
  trimClip: (filePath: string, start: number, end: number) =>
    ipcRenderer.invoke('trim-clip', filePath, start, end),
  exportClip: (filePath: string, maxBytes: number, codec?: 'auto' | 'h264') =>
    ipcRenderer.invoke('export-clip', filePath, maxBytes, codec),
  // The editor needs every audio track separately, because a video element
  // decodes only the first one, and the keyframe list to know where a cut can
  // stay lossless.
  saveClipEdit: (filePath: string, options: {
    startSeconds: number
    endSeconds: number
    gains?: { game?: number; mic?: number; other?: number }
    saturation?: number
    reEncode: boolean
  }) => ipcRenderer.invoke('save-clip-edit', filePath, options),
  decodeClipAudio: (filePath: string) => ipcRenderer.invoke('decode-clip-audio', filePath),
  getClipKeyframes: (filePath: string) => ipcRenderer.invoke('get-clip-keyframes', filePath),
  onHotkeyClip: (callback: () => void) => {
    return subscribe('hotkey-clip', callback)
  },
  onClipSavedRefresh: (callback: () => void) => {
    return subscribe('clip-saved-refresh', callback)
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getHotkeyStatus: () => ipcRenderer.invoke('hotkey-status'),
  getAutostart: () => ipcRenderer.invoke('autostart-status'),
  setAutostart: (enabled: boolean) => ipcRenderer.invoke('set-autostart', enabled),
  getLearnedGames: () => ipcRenderer.invoke('get-learned-games'),
  forgetGame: (exe: string) => ipcRenderer.invoke('forget-game', exe),
  identifyGame: (exe: string, name: string | null) => ipcRenderer.invoke('identify-game', exe, name),
  onIdentifyGame: (callback: (request: { exe: string; suggested: string }) => void) => {
    return subscribe('identify-game', callback)
  },
  setSettings: (partial: Partial<Settings>) => ipcRenderer.invoke('set-settings', partial),
  getVoiceStatus: () => ipcRenderer.invoke('voice-status'),
  pickClipsFolder: () => ipcRenderer.invoke('pick-clips-folder'),

  // Navigation
  onNavigate: (callback: (page: string) => void) => {
    return subscribe('navigate', callback)
  },

  // Sound
  onPlayClipSound: (callback: (soundPath: string) => void) => {
    return subscribe('play-clip-sound', callback)
  },

  // Game detection
  getCurrentGame: () => ipcRenderer.invoke('get-current-game'),
  onGameDetected: (callback: (game: string | null) => void) => {
    return subscribe('game-detected', callback)
  },

  // Capture engine
  capture: {
    startReplayBuffer: () => ipcRenderer.invoke('capture-start-replay'),
    stopReplayBuffer: () => ipcRenderer.invoke('capture-stop-replay'),
    saveClip: () => ipcRenderer.invoke('capture-save-clip'),
    getStatus: () => ipcRenderer.invoke('capture-status'),
    setBufferLength: (seconds: number) => ipcRenderer.invoke('capture-set-buffer-length', seconds),
    listDisplays: () => ipcRenderer.invoke('list-displays'),
    onSaveState: (callback: (state: { saving: boolean; error?: string }) => void) => {
      return subscribe('clip-save-state', callback)
    },
  },
})

export type FlashAPI = {
  platform: string
  getPlaybackVisibility: () => Promise<boolean>
  onPlaybackVisibility: (callback: (visible: boolean) => void) => () => void
  minimize: () => void
  maximize: () => void
  close: () => void
  toggleRecording: () => void
  getRecordingState: () => Promise<boolean>
  onRecordingState: (callback: (state: boolean) => void) => () => void
  hasCaptureAddon: () => Promise<boolean>
  getClips: () => Promise<ClipInfo[]>
  getStorage: () => Promise<{ used: number; clips: number }>
  deleteClip: (filePath: string) => Promise<boolean>
  renameClip: (filePath: string, name: string) => Promise<{ filePath?: string; error?: string }>
  setClipStarred: (filePath: string, starred: boolean) => Promise<{ starred?: boolean; error?: string }>
  openClip: (filePath: string) => Promise<void>
  openClipsFolder: () => Promise<void>
  showClipInFolder: (filePath: string) => Promise<void>
  startClipDrag: (filePaths: string | string[]) => void
  moveClips: (filePaths: string[], game: string) => Promise<{ moved: number; error?: string }>
  copyClipFile: (filePath: string) => Promise<boolean>
  readThumbnail: (filePath: string) => Promise<Uint8Array | null>
  writeThumbnail: (filePath: string, bytes: Uint8Array) => Promise<boolean>
  saveClipFrame: (filePath: string, playheadSeconds: number, bytes: Uint8Array) =>
    Promise<{ path?: string; error?: string }>
  trimClip: (filePath: string, start: number, end: number) =>
    Promise<{ path?: string; duration?: number; actualStartSeconds?: number; error?: string }>
  exportClip: (filePath: string, maxBytes: number, codec?: 'auto' | 'h264') =>
    Promise<{ path?: string; bytes?: number; width?: number; height?: number; bitrateKbps?: number; codec?: string; error?: string }>
  saveClipEdit: (filePath: string, options: {
    startSeconds: number
    endSeconds: number
    gains?: { game?: number; mic?: number; other?: number }
    saturation?: number
    reEncode: boolean
  }) => Promise<{ path?: string; duration?: number; actualStartSeconds?: number; error?: string }>
  decodeClipAudio: (filePath: string) =>
    Promise<{ sampleRate: number; tracks: { id: string; samples: Float32Array }[]; error?: string }>
  getClipKeyframes: (filePath: string) =>
    Promise<{ keyframesSec: number[]; durationSeconds: number; bitrateKbps: number; error?: string }>
  onHotkeyClip: (callback: () => void) => () => void
  onClipSavedRefresh: (callback: () => void) => () => void
  getSettings: () => Promise<Settings>
  getHotkeyStatus: () => Promise<{
    hotkey: string
    // One flag per key: the clip, short-clip and screenshot accelerators can
    // each be taken by another app independently.
    clip: boolean; short: boolean; screenshot: boolean
  }>
  // `enabled` is what Windows says, not what was last asked for.
  // `managedByWindows` means Flash is listed but Task Manager has disabled it.
  getAutostart: () => Promise<AutostartState>
  setAutostart: (enabled: boolean) => Promise<AutostartState>
  getLearnedGames: () => Promise<Record<string, string>>
  forgetGame: (exe: string) => Promise<Record<string, string>>
  identifyGame: (exe: string, name: string | null) => Promise<Settings>
  onIdentifyGame: (callback: (request: { exe: string; suggested: string }) => void) => () => void
  setSettings: (partial: Partial<Settings>) => Promise<Settings>
  getVoiceStatus: () => Promise<{ available: boolean; language: string; error: string }>
  pickClipsFolder: () => Promise<string | null>
  onNavigate: (callback: (page: string) => void) => () => void
  onPlayClipSound: (callback: (soundPath: string) => void) => () => void
  getCurrentGame: () => Promise<string | null>
  onGameDetected: (callback: (game: string | null) => void) => () => void
  capture: {
    startReplayBuffer: () => Promise<boolean>
    stopReplayBuffer: () => Promise<void>
    saveClip: () => Promise<{ path?: string; duration?: number; error?: string }>
    getStatus: () => Promise<{
      recording: boolean
      bufferSeconds: number
      encoder: string
      available: boolean
      // Absent when the capture engine is not loaded, which is why it is optional
      // rather than defaulted to a name that would be a lie.
      captureBackend?: string
      captureHealthy?: boolean
      captureError?: string
    }>
    setBufferLength: (seconds: number) => Promise<void>
    listDisplays: () => Promise<Display[]>
    onSaveState: (callback: (state: { saving: boolean; error?: string }) => void) => () => void
  }
}

export interface Display {
  id: number
  name: string
  width: number
  height: number
  isPrimary: boolean
  refreshHz?: number
}
