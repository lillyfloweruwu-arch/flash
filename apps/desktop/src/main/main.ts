import { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, ipcMain, screen, shell, dialog, clipboard, ClipboardItem, powerMonitor, protocol, net } from 'electron'
import { join, basename, dirname, extname } from 'path'

// Must run before the app is ready, or the scheme is not treated as privileged
// and range requests (video seeking) fail.
protocol.registerSchemesAsPrivileged([{
  scheme: 'flash-clip',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
}])
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { Readable } from 'stream'
import { pathToFileURL } from 'url'
import { createHash } from 'crypto'
import { statfs } from 'fs/promises'
import { toastHtml, overlayHtml, cornerBounds } from '../shared/windowTemplates'

import { byteRange } from '../shared/byteRange'
import { createClipDeletion } from '../shared/clipDeletion'
import { getTheme } from '../shared/themes'
import { exportSuffix, type ExportCodecChoice } from '../shared/exportLimits'
import { resolveGameSettings, type PerGameSettings } from '../shared/perGame'
import { resolveClipFilename, validateClipName } from '../shared/rename'
import { clipCreatedAt, clipTimestamp, firstFreeName, gameFolderName, isFlashClip, sidecarPath } from '../shared/clipPath'
import { migrateSidecars, readSidecar, writeSidecar, reserveOutput } from '../shared/clipFiles'
import { isInsideRoot } from '../shared/clipsRoot'
import { sanitise } from '../shared/sanitise'
import { DEFAULT_AUDIO_LANES, type AudioLanesSetting, type AudioTrackId } from '../shared/audioLanes'
import { decideAutostart } from '../shared/autostart'
import { clipPathFromUrl, captureCommand, isLinuxInfrastructure, type CaptureCommand } from '../shared/platform'
import { linuxAutostartEnabled, setLinuxAutostart, linuxProcessSnapshot } from './linux'


if (process.platform === 'linux') {
  app.setDesktopName('flash.desktop')
}

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
  overlay: !(process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland'),
  portalRestoreToken: '',
  overlayPosition: 'top-left' as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
  quality: '1080p 60fps',
  bufferLength: 30,
  audioCapture: true,
  audioLanes: DEFAULT_AUDIO_LANES as AudioLanesSetting,
  micDeviceId: '',   // empty = the Windows default communications mic
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
let sessionClipsFolder: string | null = null
const activeClipsFolder = () => sessionClipsFolder ?? settings.clipsFolder

function sanitiseSettings(parsed: unknown, defaults: Settings = DEFAULTS): Partial<Settings> {
  return sanitise(defaults, parsed)
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
  settings = { ...DEFAULTS, ...sanitiseSettings(settings) }
  settings.shortClipSeconds = Math.min(settings.shortClipSeconds, settings.bufferLength)
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

  if (process.platform !== 'win32' || !app.isPackaged || !existsSync(ico)) return
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
const isInsideClips = (filePath: string) => isInsideRoot(activeClipsFolder(), filePath)

// The only two kinds of file Flash ever puts in the library.
const MEDIA_EXTENSIONS = new Set(['.mp4', '.png'])

// Returns the error rather than throwing: this runs before the window exists,
// and a clips folder on a removable or network drive that is not mounted would
// otherwise take the whole app down at startup with nothing on screen to say
// why. Falling back to the default keeps Flash usable and recording.
function ensureClipsFolder(): string | null {
  try {
    if (!existsSync(settings.clipsFolder)) mkdirSync(settings.clipsFolder, { recursive: true })
    sessionClipsFolder = null
    return null
  } catch (error: any) {
    const unavailable = settings.clipsFolder
    if (unavailable === DEFAULTS.clipsFolder) return error?.message || 'Could not create the clips folder'
    console.warn(`Clips folder ${unavailable} is unavailable, falling back to ${DEFAULTS.clipsFolder}`, error)
    const fallback = DEFAULTS.clipsFolder
    sessionClipsFolder = fallback
    try { mkdirSync(fallback, { recursive: true }) }
    catch (fallbackError: any) { return fallbackError?.message || 'Could not create the clips folder' }
    return `${unavailable} is not available — clips are going to ${fallback} for now`
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
  if (process.platform === 'linux') return { enabled: linuxAutostartEnabled(), managedByWindows: false }
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
  if (process.platform === 'linux') {
    if (!app.isPackaged) return { ...autostartState(), error: 'Autostart requires a packaged build.' }
    try {
      setLinuxAutostart(enabled, process.env.APPIMAGE || app.getPath('exe'))
      return autostartState()
    } catch (error: any) { return { ...autostartState(), error: error?.message || 'Could not update autostart.' } }
  }
  if (process.platform !== 'win32') return { enabled: false, managedByWindows: false, error: 'Autostart is unavailable on this platform.' }
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

  if (decision.apply) {
    const result = setAutostart(true)
    if (result.error) {
      // Leave the request unconsumed so the next launch can try again; marking
      // it now would silently drop the installer's opt-in forever.
      console.warn('Could not apply the installer autostart request:', result.error)
      return
    }
    console.log('Autostart enabled from the installer request')
  }
  settings.autostartMarkerConsumedAt = writtenAt
  saveSettings()
}

// ── Capture Addon ────────────────────────────────────────────────────────────

type CaptureAddon = {
  setPortalRestoreToken?(token: string, callback: (token: string) => void): void
  initialize(clipsDir: string, displayId?: number): { error?: string }
  startReplayBuffer(): boolean
  stopReplayBuffer(): void
  // seconds omitted = the whole buffer, exactly as before.
  saveClip(seconds?: number): Promise<{ path: string; duration: number; game: string }>
  saveScreenshot(path: string): Promise<string>
  setClipsDir?(path: string): void
  trimClip?(input: string, output: string, startSeconds: number, endSeconds: number):
    Promise<{ path: string; duration: number; actualStartSeconds?: number }>
  exportClip?(input: string, output: string, options: {
    maxBytes: number; maxHeight?: number; startSeconds?: number; endSeconds?: number
    // Gains are keyed by track name so a caller cannot silence the wrong lane
    // by miscounting. Omitting either leaves the export unchanged.
    gains?: Partial<Record<AudioTrackId, number>>
    saturation?: number
    // 'auto' takes the best codec the GPU can encode; the result says which.
    codec?: ExportCodecChoice
    maxFps?: number
  }): Promise<{ path: string; duration: number; width: number; height: number; bytes: number; bitrateKbps: number; codec: string }>
  decodeClipAudio?(input: string):
    Promise<{ sampleRate: number; tracks: { id: string; samples: Float32Array }[] }>
  getClipKeyframes?(input: string):
    Promise<{ keyframesSec: number[]; durationSeconds: number; bitrateKbps: number }>
  getStatus(): {
    recording: boolean
    bufferSeconds: number
    encoder: string
    captureHealthy?: boolean
    capturePending?: boolean
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
  setAudioTracks?(tracks: Record<AudioTrackId, boolean>): void
  setAudioLanes?(lanes: AudioLanesSetting): void
  listCaptureDevices?(): { id: string; name: string; isDefault: boolean }[]
  setCaptureDevice?(id: string): void
  listAudioApps?(): { exe: string; name: string; lane: string; pid: number; capturing: boolean }[]
  capabilities?: { smartRender?: boolean; perAppAudio?: boolean }
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
  parentPid?: number
  cmdline?: string
  steamAppId?: string
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
  x?: number
  y?: number
}

let captureAddon: CaptureAddon | null = null
let captureStatusError: string | undefined
// Startup failures cannot be console.warn only: the window may never exist by
// the time they happen, and the person cannot see a log they do not open.
let captureStartupError: string | undefined

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
  try { captureAddon?.setAudioTracks?.({ game: on, mic: on, other: on, discord: on, music: on }) }
  catch (error) { console.warn('Could not apply audio capture setting', error) }
}

// Which apps are recorded to the Discord and Music lanes. Applied to the
// running capture; nothing needs restarting and saved clips are not touched.
function applyMicDevice() {
  try { captureAddon?.setCaptureDevice?.(settings.micDeviceId) }
  catch (error) { console.warn('Could not apply microphone choice', error) }
}

function applyAudioLanes() {
  try { captureAddon?.setAudioLanes?.(settings.audioLanes) }
  catch (error) { console.warn('Could not apply audio lanes', error) }
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
  if (process.platform === 'linux') return { available: false, language: '', error: 'Voice activation is not available on Linux. Use a hotkey or a compositor shortcut.' }
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

// The toast and overlay are separate windows loaded from data URLs, so they
// cannot reach the renderer's bundled font; embed it once, read from assets
// (which ship with the app), and degrade to the fallback stack if it is gone.
let antonioDataUrl: string | null = null
function antonioFont(): string {
  if (antonioDataUrl !== null) return antonioDataUrl
  try {
    antonioDataUrl = 'data:font/woff2;base64,' + readFileSync(resource('assets/fonts/antonio.woff2', 'assets/fonts/antonio.woff2')).toString('base64')
  } catch (error) {
    console.warn('Could not load the display font for the toast', error)
    antonioDataUrl = ''
  }
  return antonioDataUrl
}

function loadCaptureAddon(): CaptureAddon | null {
  const addonPath = resource('flash_capture.node', 'packages/flash-capture/build/Release/flash_capture.node')
  try { return require(addonPath) as CaptureAddon }
  catch (error: any) {
    console.warn(`Flash capture addon unavailable at ${addonPath}`, error)
    captureStartupError = `Capture engine failed to start: ${error?.message || 'the capture addon could not be loaded'}`
    return null
  }
}

let mainWindow: BrowserWindow | null = null

function reportClipError(message: string) {
  console.warn(message)
  mainWindow?.webContents.send('clip-save-state', { saving: false, error: message })
}

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

let reportedMissingClipsFolder = ''

function scanClips(): ClipInfo[] {
  const clips: ClipInfo[] = []
  const folder = activeClipsFolder()
  if (!existsSync(folder)) {
    // An unplugged or deleted folder used to read as an empty library with no
    // explanation. Say it once per missing episode, not on every refresh.
    if (reportedMissingClipsFolder !== folder) {
      reportedMissingClipsFolder = folder
      reportClipError(`Clips folder is not available: ${folder}`)
    }
    return clips
  }
  reportedMissingClipsFolder = ''

  // Scan for MP4 and PNG files in clips folder and game subfolders
  const scanDir = (dir: string, game: string) => {
    try {
      const protectedPaths = migrateSidecars(dir)
      for (const file of readdirSync(dir)) {
        const filePath = join(dir, file)
        const stat = statSync(filePath)
        if (stat.isDirectory()) {
          scanDir(filePath, file) // subfolder name = game name
        } else if (!file.includes('.partial.') && (file.endsWith('.mp4') || file.endsWith('.png'))) {
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
            game: sidecar?.game || game || 'Unknown',
            kind,
            duration: kind === 'shot' ? '—' : `${minutes}:${String(seconds).padStart(2, '0')}`,
            durationSec: estimatedSec,
            filePath,
            size: stat.size,
            createdAt: clipCreatedAt(stat),
            starred: protectedPaths.has(filePath) || sidecar?.starred === true,
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

const clipDeletion = createClipDeletion({
  allowed: (filePath, intent) => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return false
    if (migrateSidecars(dirname(filePath)).has(filePath)) return false
    const metadata = readSidecar(filePath)
    if (metadata?.unreadable) return false
    if (intent === 'manual') return true
    if (!settings.autoDeleteDays || metadata?.starred) return false
    // A file whose age cannot be read is never old enough to prune.
    const createdAt = clipCreatedAt(statSync(filePath))
    return createdAt > 0 && createdAt < Date.now() - settings.autoDeleteDays * 86400000
  },
  unlink: unlinkSync,
  cleanup: filePath => { try { unlinkSync(sidecarPath(filePath)) } catch { /* No sidecar remains to remove. */ } },
})

function deleteClip(filePath: string, intent: 'manual' | 'prune' = 'manual'): Promise<boolean> {
  return clipDeletion.remove(filePath, intent)
}

function renameClip(filePath: string, requestedName: string): { filePath?: string; error?: string } {
  if (clipDeletion.busy(filePath)) return { error: 'This clip is being deleted. Try again shortly.' }
  const name = requestedName.trim()
  const validationError = validateClipName(name)
  if (validationError) return { error: validationError }
  if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }

  const extension = extname(filePath).toLowerCase()
  if (extension !== '.mp4' && extension !== '.png') return { error: 'Only clips and screenshots can be renamed' }

  const folder = dirname(filePath)
  const originalFilename = basename(filePath)
  if (migrateSidecars(dirname(filePath)).has(filePath)) return { error: 'Could not migrate clip metadata' }
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
  if (clipDeletion.busy(filePath)) return { error: 'This clip is being deleted. Try again shortly.' }
  const game = requestedGame.trim()
  const validationError = validateClipName(game)
  if (validationError) return { error: validationError }
  if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }

  const sourceExtension = extname(filePath)
  const extension = sourceExtension.toLowerCase()
  if (extension !== '.mp4' && extension !== '.png') return { error: 'Only clips and screenshots can be moved' }

  const targetFolder = join(activeClipsFolder(), game)
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
  if (migrateSidecars(dirname(filePath)).has(filePath)) return { error: 'Could not migrate clip metadata' }
  const originalSidecar = sidecarPath(filePath)
  const targetSidecar = sidecarPath(target)
  const hasSidecar = existsSync(originalSidecar)
  const metadata = readSidecar(filePath)
  if (metadata?.unreadable) return { error: 'Could not read clip metadata' }

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
    try { writeSidecar(target, { ...metadata, game }) }
    catch (error) {
      if (hasSidecar) renameSync(targetSidecar, originalSidecar)
      renameSync(target, filePath)
      throw error
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
  // exactly the wrong thing for a background timer to delete. Only files Flash
  // itself wrote are candidates: a general clips folder can contain the user's
  // own videos, and those must never be aged out by our timer.
  for (const clip of scanClips()) {
    if (clip.createdAt <= 0) continue
    if (clip.createdAt >= cutoff || clip.starred) continue
    if (!isFlashClip(basename(clip.filePath), existsSync(sidecarPath(clip.filePath)))) continue
    void deleteClip(clip.filePath, 'prune')
  }
}

// A 30s 1080p60 clip at 20 Mbps is ~75 MB. Refuse below a floor rather than
// letting the buffer quietly fill the drive and corrupt the write mid-mux.
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

async function checkDiskSpace(): Promise<string | null> {
  try {
    const fs = await statfs(activeClipsFolder())
    const free = fs.bavail * fs.bsize
    if (free < MIN_FREE_BYTES) {
      return `Only ${(free / 1e9).toFixed(1)} GB free on the clips drive — need at least 2 GB`
    }
  } catch { /* unsupported filesystem: let the save attempt decide */ }
  return null
}

// Both the hotkey and the renderer's save button land here.
function onClipSaved(clip: { path: string; duration: number }, game: string) {
  try {
    writeSidecar(clip.path, { duration: clip.duration, game })
  } catch { /* sidecar is an optimisation, not required */ }
  // The clip is already on disk; a toast that fails to draw must not turn a
  // successful save into a reported error.
  try { showClipNotification(clip.duration) } catch (error) { console.warn('Could not show the clip toast', error) }
  playClipSound()
  mainWindow?.webContents.send('clip-saved-refresh')
}

// Single save path for the hotkey, the tray and the renderer, so the disk check
// and the in-progress signal cannot be skipped by one caller.
// Mashing the clip key is exactly what people do when something good happens, and
// two saves in the same second used to open two sink writers on the same path.
// Coalesce instead: a second press while one is in flight returns that same save.
let saveInFlight: Promise<{ path?: string; duration?: number; error?: string }> | null = null
let saveInFlightSeconds: number | undefined

function saveClipNow(seconds?: number): Promise<{ path?: string; duration?: number; error?: string }> {
  // No argument means the whole buffer. Only a positive number is a short
  // clip, which is exactly how runSaveClip distinguishes the two.
  const requested = typeof seconds === 'number' && seconds > 0 ? seconds : undefined
  // Mashing the same key can share the save; a different length cannot. A
  // short-clip hotkey during a full-buffer save waits for that save and then
  // runs its own, instead of returning the wrong length.
  if (saveInFlight && saveInFlightSeconds === requested) return saveInFlight
  const previous = saveInFlight ?? Promise.resolve({} as { path?: string; duration?: number; error?: string })
  const next = previous.then(() => runSaveClip(seconds))
  const clear = () => {
    if (saveInFlight === next) { saveInFlight = null; saveInFlightSeconds = undefined }
  }
  saveInFlight = next
  saveInFlightSeconds = requested
  next.then(clear, clear)
  return next
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
    onClipSaved(clip, clip.game)
    mainWindow?.webContents.send('clip-save-state', { saving: false })
    updateOverlay(false)
    return { path: clip.path, duration: clip.duration }
  } catch (error: any) {
    const message = error?.message || 'Failed to save clip'
    console.error('Failed to save clip', error)
    mainWindow?.webContents.send('clip-save-state', { saving: false, error: message })
    updateOverlay(false)
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

    const game = currentGame ?? 'Unknown'
    const folder = join(activeClipsFolder(), gameFolderName(game))
    mkdirSync(folder, { recursive: true })
    const filename = firstFreeName(clipTimestamp(new Date()), '.png', readdirSync(folder))
    screenshotPath = join(folder, filename)

    await captureAddon.saveScreenshot(screenshotPath)
    try { writeSidecar(screenshotPath, { duration: 0, game }) }
    catch (error) { console.warn('Screenshot saved without metadata', error) }
    playClipSound()
    mainWindow?.webContents.send('clip-saved-refresh')
    // Clipboard failure must not hide a successfully published screenshot.
    try {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([readFileSync(screenshotPath)], { type: 'image/png' }) })])
    } catch (error) {
      console.warn('Screenshot saved, but clipboard copy failed', error)
      mainWindow?.webContents.send('clip-save-state', { saving: false, error: 'Screenshot saved to library, but could not copy it to the clipboard.' })
    }
  } catch (error: any) {
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
  try { if (captureAddon?.listProcesses) return captureAddon.listProcesses() }
  catch (error) { console.warn('Could not list native processes', error) }
  try { return process.platform === 'linux' ? linuxProcessSnapshot() : null }
  catch (error) { console.warn('Could not read /proc', error); return null }
}

// Tier 1 + 2: the bundled database and anything the user has already named.
function detectKnownGame(processes: ProcessEntry[], foregroundPid: number): DetectedGame | null {
  const learned = learnedGames()
  const linux = process.platform === 'linux'
  const matches: DetectedGame[] = []
  for (const process of processes) {
    if (linux && isLinuxInfrastructure(process.exe)) continue
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
  const known = detectKnownGame(current.processes, current.foregroundPid)
  if (known) return known
  if (process.platform === 'linux') {
    const game = current.processes.filter(p => p.steamAppId && !isLinuxInfrastructure(p.exe) && !ignoredExecutables.has(p.exe.toLowerCase()))
      .sort((a, b) => b.workingSet - a.workingSet)[0]
    return game ? { name: `Steam ${game.steamAppId}`, pid: game.pid, exe: game.exe } : null
  }
  return detectUnknownGame(current.processes)
}

function startGameDetection() {
  loadGameDb()
  const poll = () => {
    const game = detectCurrentGame()
    // Re-arm on a PID change too — relaunching a game keeps the name but the old
    // process tree is gone, and audio would stay bound to a dead PID.
    // `game?.name` is undefined when nothing runs and currentGame is null, so
    // compare against null explicitly - otherwise every idle poll counted as a
    // change and re-applied capture settings, resetting the replay buffer.
    if ((game?.name ?? null) !== currentGame || (game && game.pid !== currentGamePid)) {
      currentGame = game?.name ?? null
      currentGamePid = game?.pid ?? 0
      if (game) {
        applyCaptureSettings(game.name)
        try { captureAddon?.setCurrentGame(game.name, game.pid) }
        catch (error) { console.warn('Could not target game audio', error) }
      } else {
        applyCaptureSettings(null)
        try { captureAddon?.setCurrentGame('', 0) }
        catch (error) { console.warn('Could not clear game audio target', error) }
      }
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

let sessionDisplayId: number | null = null
const activeDisplayId = () => sessionDisplayId ?? settings.displayId

function availableDisplay(requested: number): number {
  try {
    const displays = captureAddon?.listDisplays?.() ?? []
    return displays.find(display => display.id === requested)?.id ?? displays.find(display => display.isPrimary)?.id ?? displays[0]?.id ?? 0
  } catch { return 0 }
}

function recoverDisplay() {
  const current = activeDisplayId()
  const next = availableDisplay(current)
  if (next === current) return
  try {
    captureAddon?.setDisplay?.(next)
    sessionDisplayId = next
  } catch (error) { console.warn('Could not recover capture display', error) }
}

function restoreSavedDisplay() {
  if (sessionDisplayId === null || sessionDisplayId === settings.displayId) return
  try {
    const displays = captureAddon?.listDisplays?.() ?? []
    if (!displays.some(display => display.id === settings.displayId)) return
    captureAddon?.setDisplay?.(settings.displayId)
    sessionDisplayId = null
  } catch (error) { console.warn('Could not restore capture display', error) }
}

function captureDisplay() {
  try {
    const selected = captureAddon?.listDisplays?.().find(display => display.id === activeDisplayId())
    if (process.platform === 'win32' && selected?.x !== undefined && selected.y !== undefined) {
      // Native DXGI uses physical pixels; Electron window bounds use DIPs.
      const centre = screen.screenToDipPoint({ x: selected.x + Math.floor(selected.width / 2), y: selected.y + Math.floor(selected.height / 2) })
      return screen.getDisplayNearestPoint(centre)
    }
  } catch { /* A disconnected display falls back to the primary display. */ }
  return screen.getPrimaryDisplay()
}

function showClipNotification(durationSeconds: number) {
  if (!settings.notifications) return

  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.close()
  }

  const notification = new BrowserWindow({
    ...cornerBounds(captureDisplay().workArea, settings.overlayPosition, 280, 72),
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false, show: false,
    type: 'toolbar', hasShadow: false,
  })

  notificationWindow = notification
  notification.setAlwaysOnTop(true, 'screen-saver')
  notification.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notification.setIgnoreMouseEvents(true, { forward: true })
  const html = toastHtml(settings.theme, antonioFont(), durationSeconds)
  notification.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  let timer: ReturnType<typeof setTimeout> | undefined
  notification.once('closed', () => {
    if (timer) clearTimeout(timer)
    if (notificationWindow === notification) notificationWindow = null
  })
  // Each callback owns its window, so an older toast cannot close a newer one.
  notification.once('ready-to-show', () => {
    if (notification.isDestroyed()) return
    notification.showInactive()
    timer = setTimeout(() => { if (!notification.isDestroyed()) notification.close() }, 3200)
  })
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

let overlaySaving = false

function overlayBounds() {
  return cornerBounds(captureDisplay().workArea, settings.overlayPosition, 240, 40)
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

  const overlay = overlayWindow
  const html = overlayHtml(settings.theme, antonioFont())
  overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  overlay.once('ready-to-show', () => {
    if (overlay.isDestroyed() || overlayWindow !== overlay) return
    overlay.showInactive()
    updateOverlay()
  })
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  overlayWindow = null
}

function updateOverlay(saving?: boolean) {
  if (saving !== undefined) overlaySaving = saving
  if (!settings.overlay) { destroyOverlay(); return }
  if (!overlayWindow || overlayWindow.isDestroyed()) { createOverlay(); return }
  overlayWindow.setBounds(overlayBounds())
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  // Only worth showing while a game is up — a permanent desktop badge is clutter.
  const state = { visible: !!currentGame || overlaySaving, recording: isRecording, game: currentGame, saving: overlaySaving }
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
        try {
          captureAddon?.stopReplayBuffer()
          setRecordingState(false)
        } catch (error) {
          console.warn('Could not stop the replay buffer', error)
          setRecordingState(readRecordingState())
        }
      } else {
        try {
          setRecordingState(captureAddon?.startReplayBuffer() ?? false)
        } catch (error) {
          console.warn('Could not start the replay buffer', error)
          setRecordingState(readRecordingState())
        }
      }
    }},
    { type: 'separator' },
    { label: 'Open Clips Folder', click: () => shell.openPath(activeClipsFolder()) },
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

  const publishVisibility = () => mainWindow?.webContents.send('playback-visibility', playbackVisible())
  mainWindow.on('show', publishVisibility)
  mainWindow.on('hide', publishVisibility)
  mainWindow.on('minimize', publishVisibility)
  mainWindow.on('restore', publishVisibility)
  mainWindow.webContents.on('did-finish-load', publishVisibility)

  mainWindow.on('close', (event) => {
    if (!(app as any).isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function playbackVisible(): boolean {
  return !!mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()
}

function setupIPC() {
  ipcMain.handle('playback-visibility', playbackVisible)
  // ── Capture ──
  ipcMain.handle('capture-start-replay', () => {
    if (!captureAddon) return false
    try {
      const started = captureAddon.startReplayBuffer()
      setRecordingState(started)
      return started
    } catch (error) {
      console.error('Failed to start replay buffer', error)
      setRecordingState(false)
      return false
    }
  })

  ipcMain.handle('capture-stop-replay', () => {
    try { captureAddon?.stopReplayBuffer() } catch { /* ignore */ }
    setRecordingState(false)
  })

  ipcMain.handle('capture-save-clip', (_event, seconds?: number) => saveClipNow(seconds))

  ipcMain.handle('list-displays', () => {
    try { return captureAddon?.listDisplays?.() ?? [] } catch { return [] }
  })

  ipcMain.handle('capture-status', () => {
    if (!captureAddon) return { recording: false, bufferSeconds: settings.bufferLength, encoder: 'none', available: false }
    try {
      const status = captureAddon.getStatus()
      return { ...status, captureError: status.captureError ?? captureStatusError, available: true }
    } catch {
      return { recording: isRecording, bufferSeconds: settings.bufferLength, encoder: 'unknown', available: true, captureError: captureStatusError }
    }
  })

  ipcMain.handle('capture-set-buffer-length', (_event, seconds: number) => {
    const changed = sanitiseSettings({ bufferLength: seconds }, settings)
    if (changed.bufferLength === undefined) return
    settings.bufferLength = changed.bufferLength
    settings.shortClipSeconds = Math.min(settings.shortClipSeconds, settings.bufferLength)
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
    if (migrateSidecars(dirname(filePath)).has(filePath)) return { error: 'Could not migrate clip metadata' }
    const sidecar = readSidecar(filePath) ?? {}
    if (sidecar.unreadable) return { error: 'Could not read clip metadata' }
    try {
      writeSidecar(filePath, { ...sidecar, starred: starred === true })
      return { starred: starred === true }
    } catch (error: any) {
      return { error: error?.message || 'Could not update this clip' }
    }
  })
  ipcMain.handle('move-clips', (_event, filePaths: string[], game: string) => moveClips(filePaths, game))
  // Library thumbnails. Each tile used to be a live <video> that was unloaded
  // whenever it scrolled away, so scrolling back showed black tiles reloading.
  // A small JPEG is now made once per clip version and kept in userData, keyed
  // by path, size and mtime so a trimmed or replaced file gets a fresh one.
  const thumbnailFile = (filePath: string): string | null => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return null
    const info = statSync(filePath)
    const key = createHash('sha1').update(`${filePath.toLowerCase()}|${info.size}|${info.mtimeMs}`).digest('hex')
    return join(app.getPath('userData'), 'thumbnails', `${key}.jpg`)
  }
  ipcMain.handle('thumbnail-read', (_event, filePath: string) => {
    try {
      const file = thumbnailFile(filePath)
      return file && existsSync(file) ? new Uint8Array(readFileSync(file)) : null
    } catch { return null }
  })
  ipcMain.handle('thumbnail-write', (_event, filePath: string, bytes: Uint8Array) => {
    try {
      const file = thumbnailFile(filePath)
      // A 480px JPEG is ~20-40 KB; anything far larger is not a thumbnail.
      if (!file || !(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 1024 * 1024) return false
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, bytes)
      return true
    } catch { return false }
  })

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
      const reservation = reserveOutput(join(folder, `${stem}.png`))
      const output = reservation.path
      try {
        writeFileSync(output, bytes, { flag: 'wx' })
        writeSidecar(output, { duration: 0, game: readSidecar(filePath)?.game ?? basename(folder) })
      } finally { reservation.release() }
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
    if (extname(filePath).toLowerCase() !== '.mp4') return { error: 'Only clips can be processed' }
    let reservation: ReturnType<typeof reserveOutput> | undefined
    const requested = filePath.replace(/\.mp4$/i, ' - trim.mp4')
    try {
      reservation = reserveOutput(requested)
      const output = reservation.path
      const result = await captureAddon.trimClip(filePath, output, start, end)
      try {
        writeSidecar(result.path, {
          duration: Math.round(result.duration), game: readSidecar(filePath)?.game ?? basename(dirname(filePath)),
        })
      } catch { /* sidecar is an optimisation */ }
      mainWindow?.webContents.send('clip-saved-refresh')
      return { path: result.path, duration: result.duration, actualStartSeconds: result.actualStartSeconds }
    } catch (error: any) {
      return { error: error?.message || 'Trim failed' }
    } finally { reservation?.release() }
  })

  // The editor's Save. Which native path it takes depends entirely on what was
  // changed: an untouched mix and unchanged colour can be remuxed, and anything
  // else has to be re-encoded. The renderer decides and says so in its badge;
  // this routes accordingly rather than deciding a second time.
  ipcMain.handle('save-clip-edit', async (_event, filePath: string, options: {
    startSeconds: number
    endSeconds: number
    gains?: Partial<Record<AudioTrackId, number>>
    saturation?: number
    reEncode: boolean
  }) => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    if (!(options.endSeconds > options.startSeconds)) return { error: 'End must be after start' }

    if (extname(filePath).toLowerCase() !== '.mp4') return { error: 'Only clips can be processed' }
    let reservation: ReturnType<typeof reserveOutput> | undefined
    const requested = filePath.replace(/\.mp4$/i, ' - edit.mp4')
    try {
      reservation = reserveOutput(requested)
      const output = reservation.path
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
          // A saved edit is opened again by the trimmer, which only reads H.264.
          codec: 'h264',
        })
      } else {
        if (!captureAddon?.trimClip) return { error: 'This build cannot trim clips' }
        result = await captureAddon.trimClip(filePath, output, options.startSeconds, options.endSeconds)
      }
      try {
        writeSidecar(result.path, {
          duration: Math.round(result.duration), game: readSidecar(filePath)?.game ?? basename(dirname(filePath)),
        })
      } catch { /* sidecar is an optimisation */ }
      mainWindow?.webContents.send('clip-saved-refresh')
      return { path: result.path, duration: result.duration, actualStartSeconds: result.actualStartSeconds }
    } catch (error: any) {
      return { error: error?.message || 'Save failed' }
    } finally { reservation?.release() }
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
  ipcMain.handle('export-clip', async (_event, filePath: string, maxBytes: number, requested?: ExportCodecChoice) => {
    if (!captureAddon?.exportClip) return { error: 'This build cannot export clips' }
    if (!isInsideClips(filePath) || !existsSync(filePath)) return { error: 'Clip not found' }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { error: 'Export size is not valid' }
    const codec: ExportCodecChoice = requested === 'h264' ? 'h264' : 'auto'
    if (extname(filePath).toLowerCase() !== '.mp4') return { error: 'Only clips can be processed' }
    let reservation: ReturnType<typeof reserveOutput> | undefined
    const requestedPath = filePath.replace(/\.mp4$/i, exportSuffix(maxBytes, codec))
    try {
      reservation = reserveOutput(requestedPath)
      const output = reservation.path
      // 60 fps is the most a chat-window player shows; anything above it is
      // bitrate spent on frames nobody sees.
      const result = await captureAddon.exportClip(filePath, output, { maxBytes, codec, maxFps: 60 })
      try {
        writeSidecar(result.path, {
          duration: Math.round(result.duration), game: readSidecar(filePath)?.game ?? basename(dirname(filePath)),
        })
      } catch { /* sidecar is an optimisation */ }
      mainWindow?.webContents.send('clip-saved-refresh')
      return result
    } catch (error: any) {
      return { error: error?.message || 'Export failed' }
    } finally { reservation?.release() }
  })

  ipcMain.handle('open-clips-folder', async () => {
    const error = await shell.openPath(activeClipsFolder())
    if (error) reportClipError(`Could not open the clips folder: ${error}`)
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
  // Electron 44 dropped writeBuffer; raw formats now go through its
  // osclipboard escape hatch. Linux file managers and Discord take a URI list.
  ipcMain.handle('copy-clip-file', async (_event, filePath: string) => {
    if (!isInsideClips(filePath) || !existsSync(filePath)) return false
    try {
      const item: Record<string, Blob | string> = process.platform === 'win32'
        ? { 'electron application/osclipboard;format="FileNameW"': new Blob([Buffer.from(`${filePath}\0`, 'ucs2')]) }
        : { 'text/uri-list': `${pathToFileURL(filePath).href}\r\n` }
      await clipboard.write([new ClipboardItem(item)])
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
    // Everything below keys off `changed`, not the raw request: a value the
    // sanitiser dropped must not trigger the side effect that applies it.
    const { clipsFolder: _ignored, ...changed } = sanitiseSettings(partial, settings)
    const previousDisplay = settings.displayId
    if (changed.displayId !== undefined) changed.displayId = availableDisplay(changed.displayId)
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
    if (changed.audioLanes !== undefined) applyAudioLanes()
    if (changed.micDeviceId !== undefined) applyMicDevice()
    if (changed.autoDeleteDays !== undefined) pruneOldClips()
    if (changed.theme !== undefined) { applyThemeIcons(); destroyOverlay(); updateOverlay() }
    if (changed.overlay !== undefined || changed.overlayPosition !== undefined) updateOverlay()
    if (changed.hotkey !== undefined || changed.hotkeyShort !== undefined || changed.screenshotHotkey !== undefined) registerHotkeys()
    if (changed.voicePhrase !== undefined) applyVoicePhrases()
    if (changed.voiceRawFloor !== undefined || changed.voiceCooldownMs !== undefined) applyVoiceThreshold()
    if (changed.voiceEnabled !== undefined) applyVoiceEnabled()
    if (changed.displayId !== undefined) {
      try { captureAddon?.setDisplay?.(changed.displayId); sessionDisplayId = null }
      catch (error) { settings.displayId = previousDisplay; saveSettings(); console.warn('Could not switch display', error) }
      checkCaptureHealth()
      updateOverlay()
    }
    return { ...settings }
  })
  ipcMain.handle('hotkey-status', () => ({ hotkey: settings.hotkey, ...hotkeyStatus }))
  ipcMain.handle('autostart-status', () => ({ ...autostartState(), supported: process.platform === 'linux' || (process.platform === 'win32' && app.isPackaged) }))
  ipcMain.handle('set-autostart', (_event, enabled: boolean) => ({
    ...setAutostart(enabled === true), supported: process.platform === 'linux' || (process.platform === 'win32' && app.isPackaged),
  }))
  ipcMain.handle('get-learned-games', () => ({ ...learnedGames() }))
  // What the Settings picker shows: apps that have an audio session right now,
  // and which lane each is recorded to.
  ipcMain.handle('list-audio-apps', () => {
    const supported = captureAddon?.capabilities?.perAppAudio === true
    if (!supported) return { supported: false, apps: [] }
    try {
      const apps = captureAddon?.listAudioApps?.() ?? []
      return { supported: true, apps: apps.map(({ exe, name, lane, capturing }) => ({ exe, name, lane, capturing })) }
    } catch (error) {
      console.warn('Could not list audio apps', error)
      return { supported: true, apps: [] }
    }
  })
  ipcMain.handle('list-mic-devices', () => {
    try { return { devices: captureAddon?.listCaptureDevices?.() ?? [] } }
    catch (error) { console.warn('Could not list microphones', error); return { devices: [] } }
  })
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
      defaultPath: activeClipsFolder(),
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    settings.clipsFolder = result.filePaths[0]
    saveSettings()
    ensureClipsFolder()
    // Without this the engine keeps writing MP4s to the old folder while the
    // library reads the new one: clips save fine and never appear.
    try { captureAddon?.setClipsDir?.(activeClipsFolder()) }
    catch (error) { console.warn('Could not update engine clips folder', error) }
    return activeClipsFolder()
  })

  // ── Recording toggle ──
  ipcMain.on('toggle-recording', () => {
    if (isRecording) {
      try {
        captureAddon?.stopReplayBuffer()
        setRecordingState(false)
      } catch (error) {
        console.warn('Could not stop the replay buffer', error)
        setRecordingState(readRecordingState())
      }
    } else {
      try {
        setRecordingState(captureAddon?.startReplayBuffer() ?? false)
      } catch (error) {
        console.warn('Could not start the replay buffer', error)
        setRecordingState(readRecordingState())
      }
    }
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
  watchdogTimer = setInterval(checkCaptureHealth, 5000)
}

function checkCaptureHealth() {
  if (!captureAddon || !isRecording) return
  let status: ReturnType<CaptureAddon['getStatus']>
  try { status = captureAddon.getStatus() } catch { return }
  if (status.capturePending) return

  // captureHealthy is the engine's own view; recording is the thread state.
  // Either going false while we believe we are recording means capture died.
  const dead = status.recording === false || status.captureHealthy === false
  if (!dead) { restartAttempts = 0; return }

  const reason = status.captureError || 'capture stopped unexpectedly'
  console.warn('Capture watchdog:', reason)
  // A portal denial is a user decision. Retrying automatically would reopen
  // the permission dialog repeatedly; the REC action is the explicit retry.
  if (process.platform === 'linux') {
    try { captureAddon.stopReplayBuffer() }
    catch (error) { console.warn('Capture watchdog: could not stop replay buffer', error) }
    setRecordingState(false, `Capture stopped: ${reason}. Press the REC badge to retry.`)
    return
  }

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

function readRecordingState(): boolean {
  try { return captureAddon?.getStatus().recording ?? false } catch { return false }
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
let commandsReady = false
const pendingCommands: CaptureCommand[] = []
function dispatchCaptureCommand(command: CaptureCommand) {
  if (!commandsReady) { pendingCommands.push(command); return }
  if (command === 'screenshot') void saveScreenshotNow()
  else void saveClipNow(command === 'short' ? settings.shortClipSeconds : undefined)
}

const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const command = captureCommand(argv)
    if (command) { dispatchCaptureCommand(command); return }
    if (!app.isReady()) return
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
      target = clipPathFromUrl(request.url, process.platform)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // Two roots are allowed: the clips folder, and the app's own bundled
    // assets. The notification sound lives in the second, and it is served over
    // this scheme for the same reason clips are - a renderer on
    // http://localhost:5173 cannot load file:// media at all.
    const normalised = target
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

    const range = byteRange(request.headers.get('Range'), size)
    if (range.status === 416) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } })
    }
    const { start, end, status } = range
    return new Response(size === 0 ? null : asWeb(start, end), {
      status,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size === 0 ? 0 : end - start + 1),
        'Accept-Ranges': 'bytes',
        // Without this every clip is cross-origin to the renderer, so a canvas
        // that draws a frame is tainted and toBlob throws: library stills and
        // Grab frame both failed. Only Flash's own pages can reach this scheme.
        'Access-Control-Allow-Origin': '*',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      },
    })
  })
}

app.on('ready', () => {
  if (!primaryInstance) return
  registerClipProtocol()
  loadSettings()
  const clipsFolderError = ensureClipsFolder()

  applyInstallerAutostartRequest()

  pruneOldClips()
  pruneTimer = setInterval(pruneOldClips, 6 * 3600 * 1000)

  captureAddon = loadCaptureAddon()
  if (captureAddon) {
    try {
      captureAddon.setPortalRestoreToken?.(settings.portalRestoreToken, token => {
        settings.portalRestoreToken = token
        saveSettings()
      })
    } catch (error) {
      console.warn('Could not restore the portal token:', error)
      captureStatusError = error instanceof Error ? error.message : String(error)
    }
    sessionDisplayId = availableDisplay(settings.displayId)
    try {
      const status = captureAddon.initialize(activeClipsFolder(), sessionDisplayId)
      if (status.error) {
        console.warn('Capture init warning:', status.error)
        captureStatusError = status.error
      }
    } catch (error) {
      console.warn('Could not initialise the capture engine:', error)
      captureStatusError = error instanceof Error ? error.message : String(error)
    }
    // Auto-start replay buffer
    applyCaptureSettings(null)
    applyAudioLanes()
    applyMicDevice()
    applyAudioCapture()
    // Voice owns the Windows default input stream and is deliberately not tied
    // to replay-buffer state. Once enabled it listens for the lifetime of Flash.
    initializeVoiceActivation()
    try {
      setRecordingState(captureAddon.startReplayBuffer())
      if (isRecording) console.log('Replay buffer started automatically')
      else {
        console.warn('Replay buffer failed to start')
        captureStartupError = 'Capture engine failed to start: the replay buffer did not start'
      }
    } catch (error: any) {
      console.warn('Could not auto-start replay buffer:', error)
      captureStartupError = `Capture engine failed to start: ${error?.message || 'the replay buffer could not start'}`
    }
  }

  createWindow()
  // Startup checks run before the window exists, so their messages have to
  // wait for one to talk to.
  const startupErrors = [clipsFolderError, captureStartupError].filter((message): message is string => !!message)
  if (startupErrors.length) {
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('clip-save-state', { saving: false, error: startupErrors.join(' · ') })
    })
  }
  createTray()
  applyThemeIcons()
  updateOverlay()
  setupIPC()
  registerHotkeys()
  startGameDetection()
  startCaptureWatchdog()
  commandsReady = true
  const initialCommand = captureCommand(process.argv)
  if (initialCommand) pendingCommands.push(initialCommand)
  for (const command of pendingCommands.splice(0)) dispatchCaptureCommand(command)

  // Resume and display changes are the two events that reliably invalidate DXGI
  // duplication. Nudge the watchdog immediately rather than waiting up to 5s.
  powerMonitor.on('resume', () => { restartAttempts = 0; checkCaptureHealth(); console.log('System resumed — rechecking capture') })
  screen.on('display-added', () => { restartAttempts = 0; restoreSavedDisplay(); recoverDisplay(); checkCaptureHealth(); updateOverlay() })
  screen.on('display-metrics-changed', () => { restartAttempts = 0; recoverDisplay(); checkCaptureHealth(); updateOverlay() })
  screen.on('display-removed', () => { restartAttempts = 0; recoverDisplay(); checkCaptureHealth(); updateOverlay() })
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
