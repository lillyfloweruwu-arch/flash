// ── Clip types ────────────────────────────────────────────────────────────────

export interface Clip {
  id: number
  title: string
  game: string
  filePath: string
  thumbnailPath: string
  duration: number       // seconds
  width: number
  height: number
  fps: number
  fileSize: number       // bytes
  createdAt: number      // unix timestamp
  views: number
  likes: number
  tags: string[]
}

// ── Capture types ─────────────────────────────────────────────────────────────

export interface CaptureStatus {
  recording: boolean
  bufferSeconds: number
  encoder: string
  gpu: string
  width: number
  height: number
}

export interface CaptureConfig {
  quality: '720p 30fps' | '1080p 60fps' | '1440p 60fps' | '4K 30fps'
  bufferLength: number   // seconds (10-120)
  audioCapture: boolean
  autoSave: boolean
  hotkey: string         // e.g. 'F8'
}

// ── Settings types ────────────────────────────────────────────────────────────

export interface NotificationSettings {
  enabled: boolean
  clipSaveSound: boolean
  clipSavePopup: boolean
}

export interface StorageSettings {
  clipsDirectory: string
  autoDeleteDays: number  // 0 = never
  maxStorageGB: number
}

export interface UserSettings {
  capture: CaptureConfig
  notifications: NotificationSettings
  storage: StorageSettings
}

// ── Game detection types ──────────────────────────────────────────────────────

export interface DetectedGame {
  name: string
  processName: string
  pid: number
  windowTitle: string
}

export interface GameEntry {
  processName: string
  displayName: string
  icon?: string
}

// ── Default settings ──────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: UserSettings = {
  capture: {
    quality: '1080p 60fps',
    bufferLength: 30,
    audioCapture: true,
    autoSave: true,
    hotkey: 'F8',
  },
  notifications: {
    enabled: true,
    clipSaveSound: true,
    clipSavePopup: true,
  },
  storage: {
    clipsDirectory: '', // Set at runtime to ~/Videos/Flash
    autoDeleteDays: 30,
    maxStorageGB: 25,
  },
}
