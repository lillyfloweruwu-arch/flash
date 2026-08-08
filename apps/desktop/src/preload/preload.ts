import { contextBridge, ipcRenderer } from 'electron'

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

  // Clips
  onHotkeyClip: (callback: () => void) => {
    ipcRenderer.on('hotkey-clip', () => callback())
  },
  clipSaved: (durationSeconds: number) => {
    ipcRenderer.send('clip-saved', durationSeconds)
  },

  // Navigation
  onNavigate: (callback: (page: string) => void) => {
    ipcRenderer.on('navigate', (_event, page) => callback(page))
  },

  // Sound
  onPlayClipSound: (callback: () => void) => {
    ipcRenderer.on('play-clip-sound', () => callback())
  },

  // Capture engine (will be wired to C++ native addon)
  capture: {
    startReplayBuffer: () => ipcRenderer.invoke('capture-start-replay'),
    stopReplayBuffer: () => ipcRenderer.invoke('capture-stop-replay'),
    saveClip: () => ipcRenderer.invoke('capture-save-clip'),
    getStatus: () => ipcRenderer.invoke('capture-status'),
    setQuality: (quality: string) => ipcRenderer.invoke('capture-set-quality', quality),
    setBufferLength: (seconds: number) => ipcRenderer.invoke('capture-set-buffer-length', seconds),
  },
})

// Type declaration for renderer
export type FlashAPI = {
  minimize: () => void
  maximize: () => void
  close: () => void
  toggleRecording: () => void
  getRecordingState: () => Promise<boolean>
  onRecordingState: (callback: (state: boolean) => void) => void
  onHotkeyClip: (callback: () => void) => void
  clipSaved: (durationSeconds: number) => void
  onNavigate: (callback: (page: string) => void) => void
  onPlayClipSound: (callback: () => void) => void
  capture: {
    startReplayBuffer: () => Promise<void>
    stopReplayBuffer: () => Promise<void>
    saveClip: () => Promise<{ path: string; duration: number }>
    getStatus: () => Promise<{ recording: boolean; bufferSeconds: number; gpu: string }>
    setQuality: (quality: string) => Promise<void>
    setBufferLength: (seconds: number) => Promise<void>
  }
}
