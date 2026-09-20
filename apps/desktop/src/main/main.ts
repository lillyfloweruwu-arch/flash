import { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, ipcMain, screen, shell, dialog, clipboard, powerMonitor, protocol, net } from 'electron'
import { join, basename, dirname, extname } from 'path'

// Must run before the app is ready, or the scheme is not treated as privileged
// and range requests (video seeking) fail.
protocol.registerSchemesAsPrivileged([{
  scheme: 'flash-clip',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}])
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { Readable } from 'stream'
import { statfs } from 'fs/promises'
import { getTheme } from '../shared/themes'
import { resolveGameSettings, type PerGameSettings } from '../shared/perGame'
import { resolveClipFilename, validateClipName } from '../shared/rename'
import { clipTimestamp, firstFreeName, gameFolderName } from '../shared/clipPath'
import { isInsideRoot } from '../shared/clipsRoot'
import { sanitise } from '../shared/sanitise'
import { decideAutostart } from '../shared/autostart'

// ── Settings (JSON file, no native deps) ─────────────────────────────────────

const DEFAULTS = {
  clipsFolder: join(app.getPath('videos'), 'Flash'),
  theme: 'blood',
  hotkey: 'F8',
  hotkeyShort: 'Shift+F8',
  screenshotHotkey: 'F9',
  shortClipSeconds: 15,
  voiceEnabled: false,
  voicePhrase: '',
  // Measured, not guessed. Across fifteen deliberate utterances the three
  // phrases scored: "flash clip short" 0.784-0.960, "flash screenshot"
  // 0.591-0.828, and "flash clip that" only 0.317-0.730 - never once High.
  // The 0.5 this started at would have silently dropped two of five "flash
  // clip that" commands, which reads as a broken feature rather than a tuned
  // one. 0.30 sits just under the worst real command observed.
  //
  // This is deliberately the permissive side of the trade: a missed clip is
  // the moment gone, while a false positive is one delete. It is set from
  // real-command data only - the false-positive half of the calibration has
  // not been run, so how much room is left above ordinary speech is unknown.
  voiceRawFloor: 0.30,
  voiceCooldownMs: 3000,
  displayId: 0,
  overlay: true,
  overlayPosition: 'top-left' as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
  quality: '1080p 60fps',
  bufferLength: 30,
  audioCapture: true,
  autoSave: true,
  notifications: true,
  autoDeleteDays: 0,  // 0 = never
  // WHICH installer request has already been acted on for this Windows
  // account, as the marker file's modification time. Not a boolean: the app
  // cannot delete the marker (it lives in Program Files, which it may not
  // write), so a plain "already done" flag would make every later install
  // ignore the checkbox. A new install writes a new marker with a new
  // timestamp, which is a new request. 0 means none consumed yet.
  autostartMarkerConsumedAt: 0,
  learnedGames: {} as Record<string, string>,   // exe (lowercase) -> display name
  ignoredGames: [] as string[],                 // exe the user said is not a game
  perGame: {} as PerGameSettings,
}

type Settings = typeof DEFAULTS

let settings: Settings = { ...DEFAULTS }
let settingsPath = ''

// The generic half of this lives in shared/sanitise.ts, where it has a
// self-check. Only the enum belongs here.
function sanitiseSettings(parsed: unknown): Partial<Settings> {
  const clean = sanitise(DEFAULTS as Record<string, unknown>, parsed) as Record<string, unknown>
  // overlayPosition is really an enum, and a wrong value crashes rather than
  // merely looking wrong: overlayBounds reads it as two booleans, and anything
  // that is not one of these four pins the pill to the wrong screen edge.
  if (typeof clean.overlayPosition === 'string' &&
      !['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(clean.overlayPosition)) {
    delete clean.overlayPosition
  }
  return clean as Partial<Settings>
}

function loadSettings() {
  settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    if (existsSync(settingsPath)) {
      settings = { ...DEFAULTS, ...sanitiseSettings(JSON.parse(readFileSync(settingsPath, 'utf8'))) }
      settings.shortClipSeconds = Math.min(settings.shortClipSeconds, settings.bufferLength)
      // "Not a game" answers have to survive a restart or Flash asks again.
      for (const exe of settings.ignoredGames ?? []) ignoredExecutables.add(exe)
    }
  } catch { /* use defaults */ }
}

function saveSettings() {
  // Written to a sibling and renamed over the real file. A direct write that is
  // interrupted (crash, power loss, full disk) leaves valid JSON impossible to
  // parse, loadSettings falls back to DEFAULTS, and every learned game, hotkey
  // and folder choice is silently gone. Rename on Windows replaces atomically.
  try {
    const temporary = `${settingsPath}.tmp`
    writeFileSync(temporary, JSON.stringify(settings, null, 2))
    renameSync(temporary, settingsPath)
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

// Repaints the tray, taskbar and shortcut icons to match the active theme.
// Shortcuts only exist in an installed build, so this is a no-op in dev.
function applyThemeIcons() {
  const png = resource(`assets/icons/${settings.theme}.png`, `assets/icons/${settings.theme}.png`)
  const ico = resource(`assets/icons/${settings.theme}.ico`, `assets/icons/${settings.theme}.ico`)
  if (!existsSync(png)) return

  const image = nativeImage.createFromPath(png)
  tray?.setImage(image.resize({ width: 16, height: 16 }))
  mainWindow?.setIcon(image)

  if (!app.isPackaged || !existsSync(ico)) return
  const shortcuts = [
    join(app.getPath('desktop'), 'Flash.lnk'),
    join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs/Flash.lnk'),
  ]
  for (const link of shortcuts) {
    if (!existsSync(link)) continue
    // ponytail: Explorer caches shortcut icons, so a changed theme can take a
    // refresh (or a relogin) to show up on the desktop. Call SHChangeNotify via
    // a native module if that ever becomes annoying enough to matter.
    // 'update' still requires the full details object, so read the existing
    // shortcut and change only the icon.
    try {
      const existing = shell.readShortcutLink(link)
      shell.writeShortcutLink(link, 'update', { ...existing, icon: ico, iconIndex: 0 })
    } catch (error) { console.warn(`Could not update shortcut icon at ${link}`, error) }
  }
}

function applyCaptureSettings(game: string | null = currentGame) {
  const resolved = resolveGameSettings(settings.perGame ?? {}, game, settings)
  try { captureAddon?.setBufferLength(resolved.bufferLength) }
  catch (error) { console.warn('Could not apply buffer length', error) }
  try { captureAddon?.setQuality?.(parseQuality(resolved.quality)) }
  catch (error) { console.warn('Could not apply quality', error) }
}

// Every path below arrives from the renderer. isInsideRoot resolves '..' and
// compares whole path segments, so neither a traversal nor a sibling folder
// sharing the root's name gets through.
const isInsideClips = (filePath: string) => isInsideRoot(settings.clipsFolder, filePath)

// The only two kinds of file Flash ever puts in the library.
const MEDIA_EXTENSIONS = new Set(['.mp4', '.png'])

// Returns the error rather than throwing: this runs before the window exists,
// and a clips folder on a removable or network drive that is not mounted would
// otherwise take the whole app down at startup with nothing on screen to say
// why. Falling back to the default keeps Flash usable and recording.
function ensureClipsFolder(): string | null {
  try {
    if (!existsSync(settings.clipsFolder)) mkdirSync(settings.clipsFolder, { recursive: true })
    return null
  } catch (error: any) {
    const unavailable = settings.clipsFolder
    if (unavailable === DEFAULTS.clipsFolder) return error?.message || 'Could not create the clips folder'
    console.warn(`Clips folder ${unavailable} is unavailable, falling back to ${DEFAULTS.clipsFolder}`, error)
    settings.clipsFolder = DEFAULTS.clipsFolder
    try { mkdirSync(settings.clipsFolder, { recursive: true }) }
    catch (fallbackError: any) { return fallbackError?.message || 'Could not create the clips folder' }
    return `${unavailable} is not available — clips are going to ${settings.clipsFolder} for now`
  }
}

// ── Start with Windows ───────────────────────────────────────────────────────

// The argument Windows launches us with, and the only way to know it did.
// Electron's `wasOpenedAtLogin` and `openAsHidden` are macOS-only, so the
// launch item carries its own flag and we read our own argv.
const AUTOSTART_FLAG = '--autostart'
const startedByWindows = process.argv.includes(AUTOSTART_FLAG)

// The installer drops this beside the app when its checkbox was ticked. It is a
// request, never a state: the app owns the actual Windows startup entry, because
// the installer runs elevated per-machine and a startup entry written from there
// would land on the administrator's account rather than the person using Flash.
const autostartMarkerPath = () => resource('autostart-requested', 'autostart-requested')

function loginItemArgs(): string[] {
  return [AUTOSTART_FLAG]
}

// Windows is the source of truth, never the settings file. Someone can turn
// Flash off in Task Manager's Startup tab, and a toggle that reported our own
// saved boolean would sit there claiming to be on.
function autostartState(): { enabled: boolean; managedByWindows: boolean } {
  if (process.platform !== 'win32' || !app.isPackaged) return { enabled: false, managedByWindows: false }
  try {
    const state = app.getLoginItemSettings({ path: app.getPath('exe'), args: loginItemArgs() })
    // executableWillLaunchAtLogin accounts for Task Manager having disabled the
    // entry, which openAtLogin on its own does not.
    return {
      enabled: state.executableWillLaunchAtLogin,
      managedByWindows: state.openAtLogin && !state.executableWillLaunchAtLogin,
    }
  } catch (error) {
    console.warn('Could not read the Windows startup entry', error)
    return { enabled: false, managedByWindows: false }
  }
}

function setAutostart(enabled: boolean): { enabled: boolean; managedByWindows: boolean; error?: string } {
  if (process.platform !== 'win32') return { enabled: false, managedByWindows: false, error: 'Only Windows has a startup list' }
  // A development run would register electron.exe in the user's Run key, which
  // is somebody else's mess to clean up.
  if (!app.isPackaged) return { enabled: false, managedByWindows: false, error: 'Only an installed build can start with Windows' }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe'), args: loginItemArgs() })
  } catch (error: any) {
    return { ...autostartState(), error: error?.message || 'Windows refused the change' }
  }
  // Read back rather than report what was asked for: the write can be refused by
  // policy without throwing.
  const state = autostartState()
  if (state.enabled !== enabled) {
    return { ...state, error: enabled ? 'Windows did not accept the change' : 'Windows still lists Flash as a startup app' }
  }
  return state
}

// Runs once at startup. Deliberately never turns autostart OFF: the marker is
// absent both when the user declined and when they simply were not asked, and
// an update that silently switched off a setting they chose would be worse than
// not having the feature.
function applyInstallerAutostartRequest() {
  if (process.platform !== 'win32') return
  const marker = autostartMarkerPath()
  let writtenAt = 0
  try { writtenAt = existsSync(marker) ? Math.round(statSync(marker).mtimeMs) : 0 }
  catch { writtenAt = 0 }

  const decision = decideAutostart({
    installerRequested: writtenAt !== 0,
    markerConsumed: writtenAt !== 0 && writtenAt === settings.autostartMarkerConsumedAt,
    currentlyEnabled: autostartState().enabled,
    packaged: app.isPackaged,
  })
  if (!decision.consumeMarker) return

  settings.autostartMarkerConsumedAt = writtenAt
  if (decision.apply) {
    const result = setAutostart(true)
    if (result.error) console.warn('Could not apply the installer autostart request:', result.error)
    else console.log('Autostart enabled from the installer request')
  }
  saveSettings()
}

// ── Capture Addon ────────────────────────────────────────────────────────────

type CaptureAddon = {
  initialize(clipsDir: string, displayId?: number): { error?: string }
  startReplayBuffer(): boolean
  stopReplayBuffer(): void
  // seconds omitted = the whole buffer, exactly as before.
  saveClip(seconds?: number): Promise<{ path: string; duration: number }>
  saveScreenshot(path: string): Promise<string>
  setClipsDir?(path: string): void
  trimClip?(input: string, output: string, startSeconds: number, endSeconds: number):
    Promise<{ path: string; duration: number; actualStartSeconds?: number }>
  exportClip?(input: string, output: string, options: {
    maxBytes: number; maxHeight?: number; startSeconds?: number; endSeconds?: number
    // Gains are keyed by track name so a caller cannot silence the wrong lane
    // by miscounting. Omitting either leaves the export unchanged.
    gains?: { game?: number; mic?: number; other?: number }
    saturation?: number
  }): Promise<{ path: string; duration: number; width: number; height: number; bytes: number; bitrateKbps: number }>
  decodeClipAudio?(input: string):
    Promise<{ sampleRate: number; tracks: { id: string; samples: Float32Array }[] }>
  getClipKeyframes?(input: string):
    Promise<{ keyframesSec: number[]; durationSeconds: number; bitrateKbps: number }>
  getStatus(): {
    recording: boolean
    bufferSeconds: number
    encoder: string
    captureHealthy?: boolean
    captureError?: string
    // Which screen-capture backend is actually running. Desktop Duplication
    // cannot see a fullscreen game; knowing which one is in use turns a black
    // clip from a mystery into a one-line answer.
    captureBackend?: string
  }
  setCurrentGame(game: string, processId?: number): void
  setBufferLength(seconds: number): void
  setQuality?(options: { height: number; fps: number; bitrateKbps: number }): void
  listDisplays?(): Display[]
  setDisplay?(id: number): void
  // All three recorded tracks at once. The engine keeps them separate so the
  // editor can mix them; this is the blanket on/off.
  setAudioTracks?(tracks: { game: boolean; mic: boolean; other: boolean }): void
  listProcesses?(): ProcessSnapshot
  setVoiceEnabled?(enabled: boolean): void
  setVoicePhrases?(phrases: string[]): boolean
  setVoiceThreshold?(rawFloor: number, cooldownMs: number): void
  getVoiceStatus?(): VoiceStatus
  onVoiceCommand?(callback: (phrase: string, rawConfidence: number) => void): void
}

interface VoiceStatus {
  available: boolean
  language: string
  error: string
}

interface ProcessEntry {
  pid: number
  exe: string
  path: string
  windowTitle: string
  workingSet: number
  startTicks: number
}

interface ProcessSnapshot {
  processes: ProcessEntry[]
  foregroundPid: number
}

export interface Display {
  id: number
  name: string
  width: number
  height: number
  isPrimary: boolean
  refreshHz?: number
}

let captureAddon: CaptureAddon | null = null

const BUILT_IN_VOICE_PHRASES = [
  'flash clip that',
  'flash clip short',
  'flash screenshot',
]

function configuredVoicePhrases(): string[] {
  const phrases = [...BUILT_IN_VOICE_PHRASES]
  const custom = settings.voicePhrase.trim()
  if (custom && !phrases.some(phrase => phrase.toLocaleLowerCase() === custom.toLocaleLowerCase())) {
    phrases.push(custom)
  }
  return phrases
}

// The Audio capture switch. It persisted a boolean and nothing read it, so
// turning it off changed nothing at all and clips kept their audio — which is
// the one setting where "looks applied but is not" costs you a recording you
// thought was silent.
function applyAudioCapture() {
  const on = settings.audioCapture
  try { captureAddon?.setAudioTracks?.({ game: on, mic: on, other: on }) }
  catch (error) { console.warn('Could not apply audio capture setting', error) }
}

function applyVoicePhrases() {
  if (!captureAddon?.setVoicePhrases) return
  try {
    if (!captureAddon.setVoicePhrases(configuredVoicePhrases())) {
      console.warn('Voice phrase list was rejected by the capture engine')
    }
  } catch (error) { console.warn('Could not apply voice phrases', error) }
}

function applyVoiceThreshold() {
  if (!captureAddon?.setVoiceThreshold) return
  try { captureAddon.setVoiceThreshold(settings.voiceRawFloor, settings.voiceCooldownMs) }
  catch (error) { console.warn('Could not apply voice threshold', error) }
}

function applyVoiceEnabled() {
  if (!captureAddon?.setVoiceEnabled) return
  try { captureAddon.setVoiceEnabled(settings.voiceEnabled) }
  catch (error) { console.warn('Could not update voice activation', error) }
}

function initializeVoiceActivation() {
  if (!captureAddon) return
  if (captureAddon.onVoiceCommand) {
    try { captureAddon.onVoiceCommand(handleVoiceCommand) }
    catch (error) { console.warn('Could not register voice command handler', error) }
  }
  applyVoicePhrases()
  applyVoiceThreshold()
  applyVoiceEnabled()
}

function readVoiceStatus(): VoiceStatus {
  if (!captureAddon) {
    return { available: false, language: '', error: 'Capture engine not available.' }
  }
  if (!captureAddon.getVoiceStatus) {
    return { available: false, language: '', error: 'Voice activation requires a newer capture engine build.' }
  }
  try { return captureAddon.getVoiceStatus() }
  catch (error: any) {
    return { available: false, language: '', error: error?.message || 'Could not read voice activation status.' }
  }
}

// Packaged, everything ships flat in resources/; in dev it lives in the repo.
// Every non-code asset must go through here or it breaks once packaged.
function resource(packaged: string, repoRelative: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, packaged)
    : join(__dirname, '../../../..', repoRelative)
}

function loadCaptureAddon(): CaptureAddon | null {
  const addonPath = resource('flash_capture.node', 'packages/flash-capture/build/Release/flash_capture.node')
  try { return require(addonPath) as CaptureAddon }
  catch (error) { console.warn(`Flash capture addon unavailable at ${addonPath}`, error); return null }
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let notificationWindow: BrowserWindow | null = null
let isRecording = false
let currentGame: string | null = null
let currentGamePid = 0
const askedAbout = new Set<string>()
const ignoredExecutables = new Set<string>()
let gameDetectorInterval: ReturnType<typeof setInterval> | null = null

// ── Clip Management ──────────────────────────────────────────────────────────

interface ClipInfo {
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

const sidecarPath = (clipPath: string) => clipPath.slice(0, -extname(clipPath).length) + '.json'

function readSidecar(clipPath: string): { duration: number; game: string; starred?: boolean } | null {
  try { return JSON.parse(readFileSync(sidecarPath(clipPath), 'utf8')) } catch { return null }
}

function scanClips(): ClipInfo[] {
  const clips: ClipInfo[] = []
  const folder = settings.clipsFolder
  if (!existsSync(folder)) return clips

  // Scan for MP4 and PNG files in clips folder and game subfolders
  const scanDir = (dir: string, game: string) => {
    try {
      for (const file of readdirSync(dir)) {
        const filePath = join(dir, file)
        const stat = statSync(filePath)
        if (stat.isDirectory()) {
          scanDir(filePath, file) // subfolder name = game name
        } else if (file.endsWith('.mp4') || file.endsWith('.png')) {
          const kind = file.endsWith('.png') ? 'shot' : 'clip'
          const name = basename(file, extname(file))
          // Real duration comes from the sidecar written at save time; fall back to a
          // size estimate (~2MB/s at 1080p60) for clips saved before sidecars existed.
          const sidecar = readSidecar(filePath)
          const estimatedSec = kind === 'shot' ? 0 : sidecar?.duration
            ?? Math.max(1, Math.round(stat.size / (2 * 1024 * 1024)))
          const minutes = Math.floor(estimatedSec / 60)
          const seconds = estimatedSec % 60
          clips.push({
            id: filePath,
            title: name.replace(/_/g, ' ').replace(/-/g, ' '),
            game: game || 'Unknown',
            kind,
            duration: kind === 'shot' ? '—' : `${minutes}:${String(seconds).padStart(2, '0')}`,
            durationSec: estimatedSec,
            filePath,
            size: stat.size,
            createdAt: stat.birthtimeMs,
            starred: sidecar?.starred === true,
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
  if (!isInsideClips(filePath)) return false
  try { unlinkSync(filePath) } catch { return false }
  try { unlinkSync(sidecarPath(filePath)) } catch { /* no sidecar */ }
  return true
}

function renameClip(filePath: string, requestedName: string): { filePath?: string; error?: string } {
  const name = requestedName.trim()
  const validationError = validateClipName(name)
  if (validationError) return { error: validationError }
  if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }

  const extension = extname(filePath).toLowerCase()
  if (extension !== '.mp4' && extension !== '.png') return { error: 'Only clips and screenshots can be renamed' }

  const folder = dirname(filePath)
  const originalFilename = basename(filePath)
  const originalSidecar = sidecarPath(filePath)
  const originalSidecarFilename = basename(originalSidecar)
  let existing: string[]
  try {
    existing = readdirSync(folder).filter(filename => {
      const lower = filename.toLowerCase()
      return lower !== originalFilename.toLowerCase() && lower !== originalSidecarFilename.toLowerCase()
    })
  } catch (error: any) {
    return { error: error?.message || 'Could not read the clips folder' }
  }

  const target = join(folder, resolveClipFilename(name, extension, existing))
  if (target.toLowerCase() === filePath.toLowerCase()) return { filePath }
  const targetSidecar = sidecarPath(target)
  const hasSidecar = existsSync(originalSidecar)

  try {
    renameSync(filePath, target)
    if (hasSidecar) {
      try {
        renameSync(originalSidecar, targetSidecar)
      } catch (error) {
        try { renameSync(target, filePath) }
        catch (restoreError) {
          console.error('Could not restore clip after sidecar rename failed', restoreError)
          return { error: 'Rename failed and the original clip name could not be restored' }
        }
        throw error
      }
    }
    return { filePath: target }
  } catch (error: any) {
    const busy = error?.code === 'EBUSY' || error?.code === 'EPERM'
    return { error: busy ? 'Close anything using this file, then try again' : error?.message || 'Rename failed' }
  }
}

function moveClipToGame(filePath: string, requestedGame: string): { filePath?: string; error?: string } {
  const game = requestedGame.trim()
  const validationError = validateClipName(game)
  if (validationError) return { error: validationError }
  if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }

  const sourceExtension = extname(filePath)
  const extension = sourceExtension.toLowerCase()
  if (extension !== '.mp4' && extension !== '.png') return { error: 'Only clips and screenshots can be moved' }

  const targetFolder = join(settings.clipsFolder, game)
  if (dirname(filePath).toLowerCase() === targetFolder.toLowerCase()) return { filePath }

  let existing: string[]
  try {
    mkdirSync(targetFolder, { recursive: true })
    existing = readdirSync(targetFolder)
  } catch (error: any) {
    return { error: error?.message || 'Could not read the target game folder' }
  }

  const originalName = basename(filePath).slice(0, -sourceExtension.length)
  const target = join(targetFolder, resolveClipFilename(originalName, sourceExtension, existing))
  const originalSidecar = sidecarPath(filePath)
  const targetSidecar = sidecarPath(target)
  const hasSidecar = existsSync(originalSidecar)

  try {
    renameSync(filePath, target)
    if (hasSidecar) {
      try {
        renameSync(originalSidecar, targetSidecar)
      } catch (error) {
        try { renameSync(target, filePath) }
        catch (restoreError) {
          console.error('Could not restore clip after sidecar move failed', restoreError)
          return { error: 'Move failed and the original clip could not be restored' }
        }
        throw error
      }
    }
    return { filePath: target }
  } catch (error: any) {
    const busy = error?.code === 'EBUSY' || error?.code === 'EPERM'
    return { error: busy ? 'Close anything using this file, then try again' : error?.message || 'Move failed' }
  }
}

function moveClips(filePaths: string[], game: string): { moved: number; error?: string } {
  if (!Array.isArray(filePaths)) return { moved: 0, error: 'No clips selected' }
  let moved = 0
  const errors: string[] = []
  for (const filePath of filePaths) {
    const result = moveClipToGame(filePath, game)
    if (result.error) errors.push(result.error)
    else moved++
  }
  if (!errors.length) return { moved }
  const count = errors.length
  return { moved, error: `${count} item${count === 1 ? '' : 's'} could not be moved: ${errors[0]}` }
}

// Flash lives in the tray for days at a time, so running this only at launch
// meant "delete clips older than N days" quietly did nothing until the next
// restart — on a machine that never restarts, nothing at all.
let pruneTimer: ReturnType<typeof setInterval> | null = null

function pruneOldClips() {
  if (!settings.autoDeleteDays) return
  const cutoff = Date.now() - settings.autoDeleteDays * 86400000
  // A starred clip is the one the user said they wanted to keep, which makes it
  // exactly the wrong thing for a background timer to delete.
  for (const clip of scanClips()) {
    if (clip.createdAt < cutoff && !clip.starred) deleteClip(clip.filePath)
  }
}

// A 30s 1080p60 clip at 20 Mbps is ~75 MB. Refuse below a floor rather than
// letting the buffer quietly fill the drive and corrupt the write mid-mux.
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

async function checkDiskSpace(): Promise<string | null> {
  try {
    const fs = await statfs(settings.clipsFolder)
    const free = fs.bavail * fs.bsize
    if (free < MIN_FREE_BYTES) {
      return `Only ${(free / 1e9).toFixed(1)} GB free on the clips drive — need at least 2 GB`
    }
  } catch { /* unsupported filesystem: let the save attempt decide */ }
  return null
}

// Both the hotkey and the renderer's save button land here.
function onClipSaved(clip: { path: string; duration: number }) {
  try {
    writeFileSync(sidecarPath(clip.path),
      JSON.stringify({ duration: clip.duration, game: currentGame ?? 'Unknown' }))
  } catch { /* sidecar is an optimisation, not required */ }
  showClipNotification(clip.duration)
  playClipSound()
  mainWindow?.webContents.send('clip-saved-refresh')
}

// Single save path for the hotkey, the tray and the renderer, so the disk check
// and the in-progress signal cannot be skipped by one caller.
// Mashing the clip key is exactly what people do when something good happens, and
// two saves in the same second used to open two sink writers on the same path.
// Coalesce instead: a second press while one is in flight returns that same save.
let saveInFlight: Promise<{ path?: string; duration?: number; error?: string }> | null = null

function saveClipNow(seconds?: number): Promise<{ path?: string; duration?: number; error?: string }> {
  if (saveInFlight) return saveInFlight
  saveInFlight = runSaveClip(seconds).finally(() => { saveInFlight = null })
  return saveInFlight
}

async function runSaveClip(seconds?: number): Promise<{ path?: string; duration?: number; error?: string }> {
  if (!captureAddon) return { error: 'Capture engine not available' }
  if (!isRecording) return { error: 'Replay buffer is not running' }

  // Ask the engine rather than trusting our own flag. If capture died since the
  // last watchdog tick, the buffer holds stale frames and saving it would hand
  // back a clip of something that happened minutes ago — worse than no clip,
  // because it looks like it worked.
  try {
    const status = captureAddon.getStatus()
    if (status.recording === false || status.captureHealthy === false) {
      const reason = status.captureError || 'capture stopped'
      setRecordingState(false, `Capture stopped: ${reason}`)
      return { error: `Capture stopped: ${reason}` }
    }
  } catch { /* fall through and let the save attempt report the failure */ }

  const diskError = await checkDiskSpace()
  if (diskError) {
    mainWindow?.webContents.send('clip-save-state', { saving: false, error: diskError })
    return { error: diskError }
  }

  // Muxing a long clip takes real time; without this the hotkey feels dead.
  mainWindow?.webContents.send('clip-save-state', { saving: true })
  updateOverlay(true)
  try {
    // Call with no argument at all for a full-buffer save. Passing undefined is
    // not the same thing to N-API: the argument still counts, and the engine
    // rejects it as a non-numeric clip length.
    const clip = typeof seconds === 'number' && seconds > 0
      ? await captureAddon.saveClip(seconds)
      : await captureAddon.saveClip()
    onClipSaved(clip)
    mainWindow?.webContents.send('clip-save-state', { saving: false })
    updateOverlay()
    return { path: clip.path, duration: clip.duration }
  } catch (error: any) {
    const message = error?.message || 'Failed to save clip'
    console.error('Failed to save clip', error)
    mainWindow?.webContents.send('clip-save-state', { saving: false, error: message })
    updateOverlay()
    return { error: message }
  }
}

// Screenshots are taken one at a time, chained rather than concurrent. The
// filename is chosen by listing the folder, so two presses inside the same
// second would both see the name as free, pick it, and the second would
// overwrite the first. The native clip writer keeps a reservation list for the
// same reason; awaiting the previous save is the cheaper answer here.
let screenshotQueue: Promise<void> = Promise.resolve()

function saveScreenshotNow(): Promise<void> {
  screenshotQueue = screenshotQueue.then(runSaveScreenshot, runSaveScreenshot)
  return screenshotQueue
}

async function runSaveScreenshot(): Promise<void> {
  let screenshotPath = ''
  try {
    if (!captureAddon) throw new Error('Capture engine not available')

    const folder = join(settings.clipsFolder, gameFolderName(currentGame ?? ''))
    mkdirSync(folder, { recursive: true })
    const filename = firstFreeName(clipTimestamp(new Date()), '.png', readdirSync(folder))
    screenshotPath = join(folder, filename)

    await captureAddon.saveScreenshot(screenshotPath)
    clipboard.writeImage(nativeImage.createFromPath(screenshotPath))
    playClipSound()
    // Without this the PNG lands on disk and the open library never shows it:
    // nothing else rescans, so a screenshot looks like it silently failed.
    mainWindow?.webContents.send('clip-saved-refresh')
  } catch (error: any) {
    if (screenshotPath) {
      try {
        if (existsSync(screenshotPath) && statSync(screenshotPath).size === 0) unlinkSync(screenshotPath)
      } catch { /* the original save error is more useful */ }
    }
    const message = error?.message || 'Failed to save screenshot'
    console.error('Failed to save screenshot', error)
    mainWindow?.webContents.send('clip-save-state', { saving: false, error: message })
  }
}

function handleVoiceCommand(phrase: string, _rawConfidence: number) {
  const recognised = phrase.trim().toLocaleLowerCase()
  const custom = settings.voicePhrase.trim().toLocaleLowerCase()

  if (recognised === 'flash clip that' || (custom && recognised === custom)) {
    mainWindow?.webContents.send('hotkey-clip')
    void saveClipNow()
  } else if (recognised === 'flash clip short') {
    mainWindow?.webContents.send('hotkey-clip')
    void saveClipNow(settings.shortClipSeconds)
  } else if (recognised === 'flash screenshot') {
    void saveScreenshotNow()
  }
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
    const dbPath = resource('games.json', 'packages/flash-detector/src/games.json')
    const data = JSON.parse(readFileSync(dbPath, 'utf8'))
    for (const entry of data.games) {
      GAME_DB[entry.processName.toLowerCase()] = entry.displayName
    }
  } catch { /* Game DB not found */ }
}

// The PID matters as much as the name: the capture engine can only split game
// audio from everything else by targeting the game's process tree, and without
// a PID it falls back to a single mixed track.
// Processes that own a visible window but are never the game being played.
const NOT_A_GAME = /^(explorer|chrome|msedge|firefox|discord|spotify|steam|epicgameslauncher|electron|flash|code|obs\d*|nvidia\w*|applicationframehost|textinputhost|searchhost|startmenuexperiencehost|shellexperiencehost|systemsettings|widgets|lockapp|taskmgr|powershell|cmd|windowsterminal|wt)\.exe$/i

// Names the user has taught Flash, keyed by executable. Persisted in settings so
// a game only has to be identified once.
const learnedGames = (): Record<string, string> => settings.learnedGames ?? {}

type DetectedGame = { name: string; pid: number; exe: string; unknown?: boolean }

// One native call, no child processes.
//
// Detection used to cost three process spawns every three seconds, for the life
// of the app: `tasklist` for the known-game match, and two PowerShell scripts —
// one to guess an unrecognised game from window titles and memory, one to find
// the focused window and the candidates' start times. Measured on this machine
// that was 648ms and 627ms respectively, so an idle Flash spent roughly 40% of a
// core asking what was running. The native snapshot answers all three questions
// in 21ms. For an app whose whole argument is that it is lighter than Medal,
// that was the wrong number to leave in the background.
function snapshot(): ProcessSnapshot | null {
  try { return captureAddon?.listProcesses?.() ?? null }
  catch (error) { console.warn('Could not list processes', error); return null }
}

// Tier 1 + 2: the bundled database and anything the user has already named.
function detectKnownGame(processes: ProcessEntry[], foregroundPid: number): DetectedGame | null {
  const learned = learnedGames()
  const matches: DetectedGame[] = []
  for (const process of processes) {
    const name = GAME_DB[process.exe.toLowerCase()] ?? learned[process.exe.toLowerCase()]
    if (name) matches.push({ name, pid: process.pid, exe: process.exe })
  }
  if (!matches.length) return null
  if (matches.length === 1) return matches[0]

  // More than one known game is running — a launcher left open, or another game
  // idling in the background. Taking the first match would let enumeration order
  // decide, which files clips under whichever game happened to start first. The
  // window you are actually looking at wins instead.
  const startedAt = new Map(processes.map(process => [process.pid, process.startTicks]))
  return matches.find(match => match.pid === foregroundPid)      // the window you are looking at
    ?? matches.find(match => match.pid === currentGamePid)       // alt-tabbed away, keep what we had
    // Neither: prefer the most recently launched. If two games are open you are
    // almost always playing the one you started last, not the one left running.
    ?? [...matches].sort((a, b) => (startedAt.get(b.pid) ?? 0) - (startedAt.get(a.pid) ?? 0))[0]
}

// Tier 3: nothing recognised, so guess. A window title alone is a poor signal —
// dwm.exe and svchost.exe have one too — so this wants a real top-level window,
// a binary outside Windows, and the largest resident set among what is left,
// because games dwarf everything else running.
function detectUnknownGame(processes: ProcessEntry[]): DetectedGame | null {
  const best = processes
    .filter(process => process.windowTitle && process.path)
    .filter(process => !/^[a-z]:\\windows\\/i.test(process.path))
    .filter(process => !NOT_A_GAME.test(process.exe))
    .filter(process => !ignoredExecutables.has(process.exe.toLowerCase()))
    .filter(process => process.workingSet > 200 * 1024 * 1024)
    .sort((a, b) => b.workingSet - a.workingSet)[0]

  return best
    ? { name: best.windowTitle.trim() || best.exe.replace(/\.exe$/i, ''), pid: best.pid, exe: best.exe, unknown: true }
    : null
}

function detectCurrentGame(): DetectedGame | null {
  const current = snapshot()
  if (!current) return null
  return detectKnownGame(current.processes, current.foregroundPid) ?? detectUnknownGame(current.processes)
}

function startGameDetection() {
  loadGameDb()
  const poll = () => {
    const game = detectCurrentGame()
    // Re-arm on a PID change too — relaunching a game keeps the name but the old
    // process tree is gone, and audio would stay bound to a dead PID.
    if (game?.name !== currentGame || (game && game.pid !== currentGamePid)) {
      currentGame = game?.name ?? null
      currentGamePid = game?.pid ?? 0
      if (game) {
        applyCaptureSettings(game.name)
        try { captureAddon?.setCurrentGame(game.name, game.pid) }
        catch (error) { console.warn('Could not target game audio', error) }
      } else applyCaptureSettings(null)
      mainWindow?.webContents.send('game-detected', currentGame)
      // Unrecognised but plausible: ask rather than filing clips under a guess.
      // Asked once per executable — declining records it as "not a game".
      if (game?.unknown && !askedAbout.has(game.exe)) {
        askedAbout.add(game.exe)
        mainWindow?.webContents.send('identify-game', { exe: game.exe, suggested: game.name })
      }
      updateOverlay()
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
    type: 'toolbar', hasShadow: false,
  })

  // Default alwaysOnTop is the 'floating' level, which loses to fullscreen games.
  // 'screen-saver' is the highest level Windows exposes to a normal window and
  // clears borderless-fullscreen. True exclusive-fullscreen DirectX still owns
  // the display and needs the swapchain overlay to draw over it.
  notificationWindow.setAlwaysOnTop(true, 'screen-saver')
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notificationWindow.setIgnoreMouseEvents(true, { forward: true })

  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  const durationStr = `${minutes}:${String(seconds).padStart(2, '0')}`

  const t = getTheme(settings.theme)
  const html = `<!DOCTYPE html><html><head><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; background: transparent; overflow: hidden; }
    .toast { display: flex; align-items: center; gap: 12px; padding: 14px 18px;
      background: ${t.panel}eb; border: 1px solid ${t.edge};
      border-radius: 12px; backdrop-filter: blur(16px);
      animation: slideIn 0.3s ease-out, fadeOut 0.4s ease-in 2.6s forwards; }
    .icon { width: 36px; height: 36px; border-radius: 8px; background: ${t.accent}26;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .icon svg { color: ${t.accent}; }
    .text h3 { font-size: 13px; font-weight: 600; color: ${t.fg}; margin-bottom: 2px; }
    .text p { font-size: 11px; color: ${t.muted}; }
    .text .dur { color: ${t.accent}; font-weight: 500; }
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
  // showInactive: show() would steal focus from the game the user is playing.
  notificationWindow.once('ready-to-show', () => {
    notificationWindow?.showInactive()
    notificationWindow?.setAlwaysOnTop(true, 'screen-saver')
  })
  setTimeout(() => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.close()
      notificationWindow = null
    }
  }, 3200)
}

function playClipSound() {
  if (!settings.notifications) return
  const soundPath = resource('assets/sounds/clip-saved.wav', 'assets/sounds/clip-saved.wav')
  mainWindow?.webContents.send('play-clip-sound', soundPath)
}

// ── In-Game Overlay ───────────────────────────────────────────────────────────

// Deliberately NOT a DirectX/Vulkan hook. Injecting into a game's render loop is
// what kernel anti-cheat (Vanguard, EAC, BattlEye) flags, and a false positive
// costs real accounts. This is our own click-through window composited by DWM:
// it never touches the game process. The tradeoff is that it cannot draw over
// true exclusive-fullscreen — borderless and windowed are fine.
let overlayWindow: BrowserWindow | null = null

function overlayBounds() {
  const display = screen.getPrimaryDisplay().workArea
  const [w, h, pad] = [188, 40, 16]
  const right = settings.overlayPosition.endsWith('right')
  const bottom = settings.overlayPosition.startsWith('bottom')
  return {
    width: w, height: h,
    x: right ? display.x + display.width - w - pad : display.x + pad,
    y: bottom ? display.y + display.height - h - pad : display.y + pad,
  }
}

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return
  overlayWindow = new BrowserWindow({
    ...overlayBounds(),
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false, show: false, hasShadow: false, type: 'toolbar',
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  const t = getTheme(settings.theme)
  const html = `<!DOCTYPE html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;background:transparent;overflow:hidden}
    .pill{display:flex;align-items:center;gap:9px;padding:10px 14px;border-radius:10px;
      background:${t.panel}e0;border:1px solid ${t.edge};backdrop-filter:blur(12px);
      opacity:0;transition:opacity .25s ease}
    .pill.on{opacity:1}
    .dot{width:7px;height:7px;border-radius:50%;background:${t.accent};flex-shrink:0}
    .dot.live{animation:blink 1.4s ease-in-out infinite}
    .dot.idle{background:${t.muted}}
    .label{font-size:11px;font-weight:600;color:${t.fg};letter-spacing:.02em}
    .game{font-size:11px;color:${t.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
  </style></head><body>
    <div class="pill" id="pill"><div class="dot" id="dot"></div>
      <span class="label" id="label">REC</span><span class="game" id="game"></span></div>
    <script>
      window.setState = (s) => {
        document.getElementById('pill').className = 'pill' + (s.visible ? ' on' : '')
        document.getElementById('dot').className = 'dot ' + (s.recording ? 'live' : 'idle')
        document.getElementById('label').textContent = s.saving ? 'SAVING' : s.recording ? 'REC' : 'IDLE'
        document.getElementById('game').textContent = s.game || ''
      }
    </script>
  </body></html>`
  overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  overlayWindow.once('ready-to-show', () => { overlayWindow?.showInactive(); updateOverlay() })
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  overlayWindow = null
}

function updateOverlay(saving = false) {
  if (!settings.overlay) { destroyOverlay(); return }
  if (!overlayWindow || overlayWindow.isDestroyed()) { createOverlay(); return }
  overlayWindow.setBounds(overlayBounds())
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  // Only worth showing while a game is up — a permanent desktop badge is clutter.
  const state = { visible: !!currentGame || saving, recording: isRecording, game: currentGame, saving }
  overlayWindow.webContents.executeJavaScript(`window.setState(${JSON.stringify(state)})`).catch(() => {})
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  // Placeholder image only — applyThemeIcons() swaps in the themed one.
  tray = new Tray(nativeImage.createFromPath(resource('assets/icon.png', 'assets/icon.png')))
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
    // No titleBarOverlay: Chromium draws those controls on top of the app's own
    // top-right buttons. The window controls are rendered in React instead.
    frame: false,
    // Created hidden when Windows launched us, not shown and then hidden: the
    // second way paints a full window for a frame before it disappears, at every
    // single login. Every other background app on a normal machine starts quiet
    // (Steam -silent, Discord --start-inactive, Spotify --minimized).
    show: !startedByWindows,
    backgroundColor: '#0C0607',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    icon: resource('assets/icon-512.png', 'assets/icon-512.png'),
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

  ipcMain.handle('capture-save-clip', (_event, seconds?: number) => saveClipNow(seconds))

  ipcMain.handle('list-displays', () => {
    try { return captureAddon?.listDisplays?.() ?? [] } catch { return [] }
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
    applyCaptureSettings()
  })

  ipcMain.handle('voice-status', () => readVoiceStatus())

  // ── Clips ──
  ipcMain.handle('get-clips', () => scanClips())
  ipcMain.handle('get-storage', () => getStorageUsage())
  ipcMain.handle('delete-clip', (_event, filePath: string) => deleteClip(filePath))
  ipcMain.handle('rename-clip', (_event, filePath: string, name: string) => renameClip(filePath, name))
  // Kept in the clip's own sidecar rather than in settings, so a starred clip
  // that is moved to another machine, or restored from a backup, is still
  // starred - and so a settings file that gets reset cannot silently un-protect
  // everything from the auto-delete timer.
  ipcMain.handle('set-clip-starred', (_event, filePath: string, starred: boolean) => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    const sidecar = readSidecar(filePath) ?? { duration: 0, game: 'Unknown' }
    try {
      writeFileSync(sidecarPath(filePath), JSON.stringify({ ...sidecar, starred: starred === true }))
      return { starred: starred === true }
    } catch (error: any) {
      return { error: error?.message || 'Could not update this clip' }
    }
  })
  ipcMain.handle('move-clips', (_event, filePaths: string[], game: string) => moveClips(filePaths, game))
  ipcMain.handle('save-clip-frame', (_event, filePath: string, playheadSeconds: number, bytes: Uint8Array) => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    if (extname(filePath).toLowerCase() !== '.mp4') return { error: 'Frames can only be grabbed from clips' }
    if (!Number.isFinite(playheadSeconds) || playheadSeconds < 0) return { error: 'Invalid playhead position' }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { error: 'Screenshot was empty' }

    const folder = dirname(filePath)
    try {
      const totalMilliseconds = Math.round(playheadSeconds * 1000)
      const milliseconds = totalMilliseconds % 1000
      const totalSeconds = Math.floor(totalMilliseconds / 1000)
      const seconds = totalSeconds % 60
      const totalMinutes = Math.floor(totalSeconds / 60)
      const minutes = totalMinutes % 60
      const hours = Math.floor(totalMinutes / 60)
      const pad = (value: number, length = 2) => String(value).padStart(length, '0')
      const timestamp = `${pad(hours)}-${pad(minutes)}-${pad(seconds)}.${pad(milliseconds, 3)}`
      const stem = `${basename(filePath, extname(filePath))} - ${timestamp}`
      const output = join(folder, firstFreeName(stem, '.png', readdirSync(folder)))
      writeFileSync(output, bytes)
      mainWindow?.webContents.send('clip-saved-refresh')
      return { path: output }
    } catch (error: any) {
      return { error: error?.message || 'Could not save screenshot' }
    }
  })
  // openPath hands the file to whatever Windows has associated with it, which
  // for an .exe or .bat means running it. The path comes over the bridge, so it
  // has to be a media file inside the library before it goes anywhere near the
  // shell — the same rule every other clip handler already follows.
  ipcMain.handle('open-clip', (_event, filePath: string) => {
    if (!isInsideClips(filePath) || !MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) return
    shell.openPath(filePath)
  })
  // Trim is lossless: a remux, not a re-encode, so this returns in well under a
  // second even for a long clip. Writes beside the original with a " - trim"
  // suffix rather than overwriting, since the cut snaps to a keyframe and the
  // user may want to retry with different bounds.
  ipcMain.handle('trim-clip', async (_event, filePath: string, start: number, end: number) => {
    if (!captureAddon?.trimClip) return { error: 'This build cannot trim clips' }
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    if (!(end > start)) return { error: 'End must be after start' }
    const output = filePath.replace(/\.mp4$/i, ` - trim ${Date.now()}.mp4`)
    try {
      const result = await captureAddon.trimClip(filePath, output, start, end)
      try {
        writeFileSync(sidecarPath(result.path), JSON.stringify({
          duration: Math.round(result.duration), game: readSidecar(filePath)?.game ?? 'Unknown',
        }))
      } catch { /* sidecar is an optimisation */ }
      mainWindow?.webContents.send('clip-saved-refresh')
      return { path: result.path, duration: result.duration, actualStartSeconds: result.actualStartSeconds }
    } catch (error: any) {
      return { error: error?.message || 'Trim failed' }
    }
  })

  // The editor's Save. Which native path it takes depends entirely on what was
  // changed: an untouched mix and unchanged colour can be remuxed, and anything
  // else has to be re-encoded. The renderer decides and says so in its badge;
  // this routes accordingly rather than deciding a second time.
  ipcMain.handle('save-clip-edit', async (_event, filePath: string, options: {
    startSeconds: number
    endSeconds: number
    gains?: { game?: number; mic?: number; other?: number }
    saturation?: number
    reEncode: boolean
  }) => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    if (!(options.endSeconds > options.startSeconds)) return { error: 'End must be after start' }

    const output = filePath.replace(/\.mp4$/i, ` - edit ${Date.now()}.mp4`)
    try {
      let result: { path: string; duration: number; actualStartSeconds?: number }
      if (options.reEncode) {
        if (!captureAddon?.exportClip) return { error: 'This build cannot re-encode clips' }
        // A ceiling high enough that the size budget never downscales. This is
        // a full-quality edit, not a share copy.
        result = await captureAddon.exportClip(filePath, output, {
          maxBytes: Number.MAX_SAFE_INTEGER,
          startSeconds: options.startSeconds,
          endSeconds: options.endSeconds,
          gains: options.gains,
          saturation: options.saturation,
        })
      } else {
        if (!captureAddon?.trimClip) return { error: 'This build cannot trim clips' }
        result = await captureAddon.trimClip(filePath, output, options.startSeconds, options.endSeconds)
      }
      try {
        writeFileSync(sidecarPath(result.path), JSON.stringify({
          duration: Math.round(result.duration), game: readSidecar(filePath)?.game ?? 'Unknown',
        }))
      } catch { /* sidecar is an optimisation */ }
      mainWindow?.webContents.send('clip-saved-refresh')
      return { path: result.path, duration: result.duration, actualStartSeconds: result.actualStartSeconds }
    } catch (error: any) {
      return { error: error?.message || 'Save failed' }
    }
  })

  // Read-only, but both walk or decode the whole file, so the addon runs them
  // on a worker thread and these just await.
  ipcMain.handle('decode-clip-audio', async (_event, filePath: string) => {
    if (!captureAddon?.decodeClipAudio) return { error: 'This build cannot decode clip audio' }
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    try {
      return await captureAddon.decodeClipAudio(filePath)
    } catch (error: any) {
      return { error: error?.message || 'Could not read the clip audio' }
    }
  })

  ipcMain.handle('get-clip-keyframes', async (_event, filePath: string) => {
    if (!captureAddon?.getClipKeyframes) return { error: 'This build cannot read keyframes' }
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    try {
      return await captureAddon.getClipKeyframes(filePath)
    } catch (error: any) {
      return { error: error?.message || 'Could not read the clip keyframes' }
    }
  })

  // A share copy, not a replacement. Capture bitrate stays archival-high on
  // purpose; this produces a small sibling that actually fits an upload limit.
  ipcMain.handle('export-clip', async (_event, filePath: string, maxBytes: number) => {
    if (!captureAddon?.exportClip) return { error: 'This build cannot export clips' }
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    const mb = Math.round(maxBytes / (1024 * 1024))
    const output = filePath.replace(/\.mp4$/i, ` - ${mb}MB.mp4`)
    try {
      const result = await captureAddon.exportClip(filePath, output, { maxBytes })
      try {
        writeFileSync(sidecarPath(result.path), JSON.stringify({
          duration: Math.round(result.duration), game: readSidecar(filePath)?.game ?? 'Unknown',
        }))
      } catch { /* sidecar is an optimisation */ }
      mainWindow?.webContents.send('clip-saved-refresh')
      return result
    } catch (error: any) {
      return { error: error?.message || 'Export failed' }
    }
  })

  ipcMain.handle('open-clips-folder', () => {
    shell.openPath(settings.clipsFolder)
  })
  ipcMain.handle('show-clip-in-folder', (_event, filePath: string) => {
    if (!isInsideClips(filePath)) return
    shell.showItemInFolder(filePath)
  })

  // Native OS drag, so a clip can be dropped straight into Discord. Must be
  // startDrag on the sender's webContents — an ipcMain.handle reply cannot start
  // a drag, so this is `on`, not `handle`.
  ipcMain.on('start-clip-drag', (event, requestedPaths: string[] | string) => {
    const filePaths = Array.isArray(requestedPaths) ? requestedPaths : [requestedPaths]
    const files = filePaths.filter(filePath => isInsideClips(filePath) && existsSync(filePath))
    if (!files.length) return
    const thumb = nativeImage.createFromPath(
      resource(`assets/icons/${settings.theme}.png`, `assets/icons/${settings.theme}.png`))
    // Electron's type still requires the legacy singular field even though
    // `files` overrides it at runtime.
    event.sender.startDrag({ file: files[0], files, icon: thumb.resize({ width: 64, height: 64 }) })
  })

  // Copy as a file (not a path) so Ctrl+V in Explorer or Discord pastes the clip.
  // CF_HDROP is not exposed by Electron, but Windows also accepts the shell's
  // "FileNameW" format, which is a single null-terminated UTF-16 path.
  ipcMain.handle('copy-clip-file', (_event, filePath: string) => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return false
    try {
      clipboard.writeBuffer('FileNameW', Buffer.from(`${filePath}\0`, 'ucs2'))
      return true
    } catch (error) {
      console.warn('Could not copy clip to clipboard', error)
      return false
    }
  })

  // ── Settings ──
  ipcMain.handle('get-settings', () => ({ ...settings }))
  ipcMain.handle('set-settings', (_event, partial: Partial<Settings>) => {
    // clipsFolder is the boundary every other handler checks against, so it is
    // not something the renderer gets to move: pointing it at C:\ would make the
    // whole drive deletable through delete-clip. It changes only through
    // pick-clips-folder, where the user picks the folder in an OS dialog.
    // sanitiseSettings runs here too — a bad value from the renderer crashes
    // exactly like a bad value from the file.
    const { clipsFolder: _ignored, ...rest } = partial
    // Everything below keys off `changed`, not the raw request: a value the
    // sanitiser dropped must not trigger the side effect that applies it.
    const changed = sanitiseSettings(rest)
    Object.assign(settings, changed)
    // A short clip longer than the buffer it is cut from cannot exist: the save
    // returns the whole buffer and the UI goes on claiming the longer number.
    // Enforced here rather than only in the slider, because the buffer can be
    // shortened after the short-clip length was set.
    settings.shortClipSeconds = Math.min(settings.shortClipSeconds, settings.bufferLength)
    saveSettings()
    if (changed.bufferLength !== undefined || changed.quality !== undefined || changed.perGame !== undefined) {
      applyCaptureSettings()
    }
    if (changed.audioCapture !== undefined) applyAudioCapture()
    if (changed.autoDeleteDays !== undefined) pruneOldClips()
    if (changed.theme !== undefined) { applyThemeIcons(); destroyOverlay(); updateOverlay() }
    if (changed.overlay !== undefined || changed.overlayPosition !== undefined) updateOverlay()
    if (changed.hotkey !== undefined || changed.hotkeyShort !== undefined || changed.screenshotHotkey !== undefined) registerHotkeys()
    if (changed.voicePhrase !== undefined) applyVoicePhrases()
    if (changed.voiceRawFloor !== undefined || changed.voiceCooldownMs !== undefined) applyVoiceThreshold()
    if (changed.voiceEnabled !== undefined) applyVoiceEnabled()
    if (changed.displayId !== undefined) {
      try { captureAddon?.setDisplay?.(changed.displayId) } catch (error) { console.warn('Could not switch display', error) }
    }
    return { ...settings }
  })
  ipcMain.handle('hotkey-status', () => ({ hotkey: settings.hotkey, ...hotkeyStatus }))
  ipcMain.handle('autostart-status', () => ({ ...autostartState(), supported: process.platform === 'win32' && app.isPackaged }))
  ipcMain.handle('set-autostart', (_event, enabled: boolean) => ({
    ...setAutostart(enabled === true), supported: process.platform === 'win32' && app.isPackaged,
  }))
  ipcMain.handle('get-learned-games', () => ({ ...learnedGames() }))
  ipcMain.handle('forget-game', (_event, exe: string) => {
    const learned = { ...learnedGames() }
    delete learned[exe.toLowerCase()]
    settings.learnedGames = learned
    askedAbout.delete(exe)
    saveSettings()
    return { ...learned }
  })

  // The user naming an unrecognised process. A null name means "not a game",
  // recorded so Flash stops asking about it.
  ipcMain.handle('identify-game', (_event, exe: string, name: string | null) => {
    const key = exe.toLowerCase()
    const learned = { ...learnedGames() }
    if (name) learned[key] = name
    else delete learned[key]
    settings.learnedGames = learned
    if (!name && !settings.ignoredGames.includes(key)) settings.ignoredGames = [...settings.ignoredGames, key]
    if (!name) ignoredExecutables.add(key)
    saveSettings()
    if (name) {
      currentGame = name
      applyCaptureSettings(name)
      try { captureAddon?.setCurrentGame(name, currentGamePid) } catch { /* audio stays mixed */ }
      mainWindow?.webContents.send('game-detected', name)
      updateOverlay()
    }
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
    // Without this the engine keeps writing MP4s to the old folder while the
    // library reads the new one: clips save fine and never appear.
    try { captureAddon?.setClipsDir?.(settings.clipsFolder) }
    catch (error) { console.warn('Could not update engine clips folder', error) }
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

// ── Capture Watchdog ──────────────────────────────────────────────────────────

// The capture thread can die under us — a UAC prompt, Win+L, the secure desktop,
// a driver reset, a monitor sleeping. Nothing upstream noticed: isRecording stayed
// true, the tray still said Stop, the overlay still blinked REC, and the hotkey
// happily returned a clip from whenever capture actually died. Finding that out
// while watching the clip is the failure that sends someone back to Medal.
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let restartAttempts = 0
let lastRestart = 0

function startCaptureWatchdog() {
  watchdogTimer = setInterval(() => {
    if (!captureAddon || !isRecording) return
    let status: ReturnType<CaptureAddon['getStatus']>
    try { status = captureAddon.getStatus() } catch { return }

    // captureHealthy is the engine's own view; recording is the thread state.
    // Either going false while we believe we are recording means capture died.
    const dead = status.recording === false || status.captureHealthy === false
    if (!dead) { restartAttempts = 0; return }

    const reason = status.captureError || 'capture stopped unexpectedly'
    console.warn('Capture watchdog:', reason)

    // Cap restarts so a genuinely broken machine does not become a restart loop.
    const now = Date.now()
    if (now - lastRestart > 60_000) restartAttempts = 0
    if (restartAttempts >= 3) {
      setRecordingState(false, `Capture stopped: ${reason}. Press the REC badge to retry.`)
      return
    }
    restartAttempts++
    lastRestart = now

    try {
      captureAddon.stopReplayBuffer()
      const restarted = captureAddon.startReplayBuffer()
      if (restarted) {
        console.log('Capture watchdog: replay buffer restarted')
        setRecordingState(true)
        return
      }
    } catch (error) {
      console.warn('Capture watchdog: restart failed', error)
    }
    setRecordingState(false, `Capture stopped: ${reason}`)
  }, 5000)
}

// One place that fixes the flag, the tray, the overlay and the renderer together,
// so they cannot disagree about whether Flash is recording.
function setRecordingState(recording: boolean, error?: string) {
  isRecording = recording
  updateTrayMenu()
  updateOverlay()
  mainWindow?.webContents.send('recording-state', recording)
  if (error) mainWindow?.webContents.send('clip-save-state', { saving: false, error })
}

// ── Hotkeys ───────────────────────────────────────────────────────────────────

// True if the accelerator was claimed. Another app (or a game) holding the same
// key makes this false, which the UI surfaces rather than failing silently. All
// three are tracked: a screenshot key silently lost to another app used to be
// invisible, because Settings drew the other two rows as registered no matter
// what happened.
const hotkeyStatus = { clip: false, short: false, screenshot: false }
let hotkeyRegistered = false

// register() throws on a malformed accelerator and returns false on a taken one.
// Both mean "this key does not work", and both have to reach the UI.
function claim(accelerator: string, handler: () => void): boolean {
  if (!accelerator) return false
  try { return globalShortcut.register(accelerator, handler) }
  catch { return false }
}

function registerHotkeys(): boolean {
  globalShortcut.unregisterAll()

  hotkeyStatus.clip = claim(settings.hotkey, () => {
    mainWindow?.webContents.send('hotkey-clip')
    void saveClipNow()
  })

  // A second key for a short clip. An eight-second play should not ship as
  // thirty seconds of nothing.
  // A key that duplicates another Flash action counts as unregistered rather
  // than silently doing nothing: the first claim wins and the duplicate row
  // should say so.
  hotkeyStatus.short = settings.hotkeyShort !== settings.hotkey &&
    claim(settings.hotkeyShort, () => {
      mainWindow?.webContents.send('hotkey-clip')
      void saveClipNow(settings.shortClipSeconds)
    })

  hotkeyStatus.screenshot =
    settings.screenshotHotkey !== settings.hotkey &&
    settings.screenshotHotkey !== settings.hotkeyShort &&
    claim(settings.screenshotHotkey, () => { void saveScreenshotNow() })

  hotkeyRegistered = hotkeyStatus.clip
  if (!hotkeyStatus.clip) console.warn(`Could not register clip hotkey ${settings.hotkey} — already taken`)
  if (!hotkeyStatus.short) console.warn(`Could not register short-clip hotkey ${settings.hotkeyShort} — already taken`)
  if (!hotkeyStatus.screenshot) console.warn(`Could not register screenshot hotkey ${settings.screenshotHotkey} — already taken`)
  updateTrayMenu()
  return hotkeyRegistered
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────

// The window hides to tray on close, so clicking the shortcut again is the most
// natural thing a user does — and without this it starts a SECOND instance with
// its own capture thread, encoder and settings writer, whose hotkey registration
// then fails, leaving the window you are looking at unable to clip.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) createWindow()
    // Windows launching a second copy at login, while Flash is already open, is
    // not a request to come to the front. Clicking the shortcut is.
    if (argv.includes(AUTOSTART_FLAG)) return
    mainWindow?.show()
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })
}

// Clips are served over their own scheme rather than file://.
//
// In development the renderer is a page on http://localhost:5173, and Chromium
// refuses to load file:// media into an http origin - "Media load rejected by
// URL safety check" - so every video was black, the play button did nothing,
// and filmstrip thumbnails never rendered. Only the packaged build, whose
// renderer is itself file://, ever worked.
//
// A privileged scheme fixes both builds with one code path and, unlike turning
// webSecurity off, keeps the renderer unable to read arbitrary files: this
// handler serves nothing outside the clips folder. `stream` is required or
// seeking in a video breaks, since range requests would not be honoured.
function registerClipProtocol() {
  protocol.handle('flash-clip', async request => {
    let target: string
    try {
      // The URL carries a "local" host purely so Chromium does not treat the
      // drive letter as one. Everything after it is the path.
      target = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, '')
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // Two roots are allowed: the clips folder, and the app's own bundled
    // assets. The notification sound lives in the second, and it is served over
    // this scheme for the same reason clips are - a renderer on
    // http://localhost:5173 cannot load file:// media at all.
    const normalised = target.replace(/\//g, '\\')
    const assetRoot = resource('assets', 'assets')
    const allowed = isInsideClips(normalised) || isInsideRoot(assetRoot, normalised)
    if (!allowed) {
      return new Response('forbidden', { status: 403 })
    }
    if (!existsSync(normalised)) return new Response('not found', { status: 404 })

    // Range support is what makes a clip seekable. Handing back the whole file
    // in one response plays fine from the start and reports an empty
    // `seekable` range, so the scrubber cannot jump anywhere - measured as
    // "asked for 15.00s, landed at 0.00, seekable 0.0-0.0".
    const size = statSync(normalised).size
    // The scheme serves clips and the notification sound; a wav announced as
    // video/mp4 will not play.
    const contentType = normalised.toLowerCase().endsWith(".wav") ? "audio/wav"
      : normalised.toLowerCase().endsWith(".png") ? "image/png"
      : "video/mp4"
    const asWeb = (start: number, end: number) =>
      Readable.toWeb(createReadStream(normalised, { start, end })) as unknown as ReadableStream<Uint8Array>

    const range = request.headers.get('Range')
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
    if (!match) {
      return new Response(asWeb(0, size - 1), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
        },
      })
    }

    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (!(start >= 0 && start <= end && end < size)) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
    return new Response(asWeb(start, end), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      },
    })
  })
}

app.on('ready', () => {
  registerClipProtocol()
  loadSettings()
  const clipsFolderError = ensureClipsFolder()

  applyInstallerAutostartRequest()

  pruneOldClips()
  pruneTimer = setInterval(pruneOldClips, 6 * 3600 * 1000)

  captureAddon = loadCaptureAddon()
  if (captureAddon) {
    const status = captureAddon.initialize(settings.clipsFolder, settings.displayId)
    if (status.error) console.warn('Capture init warning:', status.error)
    // Auto-start replay buffer
    applyCaptureSettings(null)
    applyAudioCapture()
    // Voice owns the Windows default input stream and is deliberately not tied
    // to replay-buffer state. Once enabled it listens for the lifetime of Flash.
    initializeVoiceActivation()
    try {
      isRecording = captureAddon.startReplayBuffer()
      if (isRecording) console.log('Replay buffer started automatically')
      else console.warn('Replay buffer failed to start')
    } catch (error) {
      console.warn('Could not auto-start replay buffer:', error)
    }
  }

  createWindow()
  // The folder check runs before the window exists, so its message has to wait
  // for one to talk to.
  if (clipsFolderError) {
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('clip-save-state', { saving: false, error: clipsFolderError })
    })
  }
  createTray()
  applyThemeIcons()
  updateOverlay()
  setupIPC()
  registerHotkeys()
  startGameDetection()
  startCaptureWatchdog()

  // Resume and display changes are the two events that reliably invalidate DXGI
  // duplication. Nudge the watchdog immediately rather than waiting up to 5s.
  powerMonitor.on('resume', () => { restartAttempts = 0; console.log('System resumed — rechecking capture') })
  screen.on('display-metrics-changed', () => { restartAttempts = 0 })
  screen.on('display-removed', () => { restartAttempts = 0 })
})

app.on('window-all-closed', () => { /* live in tray */ })
app.on('before-quit', () => { (app as any).isQuitting = true })
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopGameDetection()
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null }
  try { captureAddon?.setVoiceEnabled?.(false) } catch { /* ignore */ }
  try { captureAddon?.stopReplayBuffer() } catch { /* ignore */ }
})
app.on('activate', () => { if (!mainWindow) createWindow() })
