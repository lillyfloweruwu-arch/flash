import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { THEMES, DEFAULT_THEME } from '../shared/themes'
import { toAccelerator } from '../shared/accelerator'
import { clipUrl, matchesQuery } from '../shared/editor'
import { clipDisplayTitle } from '../shared/clipTitle'
import { resolveGameSettings } from '../shared/perGame'
import { clearSelection, selectRange, toggleSelection } from '../shared/selection'
import { countSyllables } from '../shared/syllables'
import { ClipActionBar } from './ClipActionBar'
import { PlayerControls } from './PlayerControls'
import { Dropdown } from './Dropdown'
import { EXPORT_LIMITS, SelectionBar } from './SelectionBar'
import Editor from './Editor'
import { useClipAudio } from './editor/useClipAudio'
import { useLiveMix } from './editor/useLiveMix'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Clip {
  id: string
  title: string
  game: string
  kind: 'clip' | 'shot'
  duration: string
  durationSec: number
  filePath: string
  size: number
  createdAt: number
}

interface Display {
  id: number
  name: string
  width: number
  height: number
  isPrimary: boolean
  refreshHz?: number
}

interface Settings {
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

const TABS = ['My Clips', 'Settings']

// Ordered by how much they cost, not by resolution, so the list reads as a
// single ladder. High frame rates are only worth offering because capture can
// actually reach them - the ceiling is the display's refresh rate, which
// Settings now shows next to this.
const QUALITY_OPTIONS = [
  '720p 30fps', '720p 60fps',
  '1080p 30fps', '1080p 60fps', '1080p 120fps', '1080p 144fps',
  '1440p 60fps', '1440p 120fps',
  '4K 30fps', '4K 60fps',
]

// The fps half of a quality string, for comparing against the display.
function qualityFps(quality: string): number {
  const match = /(\d+)fps$/.exec(quality.trim())
  return match ? Number(match[1]) : 0
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

// `display` is what the card shows; `title` is what the rename box starts
// from and what the file is actually called. They differ only for clips
// nobody has renamed, where the filename is a timestamp and the title made
// from it is six numbers in a row.
function RenameTitle({ title, display, onCommit, size = 12 }: {
  title: string
  display?: string
  onCommit: (name: string) => Promise<string | null>
  size?: number
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (!editing) setValue(title) }, [title, editing])

  const commit = async () => {
    if (busy) return
    if (value.trim() === title) { setEditing(false); setError(null); return }
    setBusy(true); setError(null)
    let message: string | null
    try { message = await onCommit(value) }
    catch (error) { message = error instanceof Error ? error.message : 'Rename failed' }
    setBusy(false)
    if (message) { setError(message); return }
    setEditing(false)
  }

  if (!editing) {
    return (
      <button type="button" title="Rename" onClick={event => { event.stopPropagation(); setEditing(true) }}
        className="flex items-center gap-1.5 min-w-0 text-left group"
        style={{ maxWidth: '100%', color: 'var(--fg)', fontSize: size, fontWeight: 500 }}>
        <span className="truncate">{display ?? title}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"
          style={{ color: 'var(--muted-3)', flexShrink: 0 }}>
          <path d="M2 8.5V10h1.5l6-6L8 2.5l-6 6zM7.5 3l1.5 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    )
  }

  return (
    <div draggable={false} onClick={event => event.stopPropagation()} style={{ width: '100%', maxWidth: 420 }}>
      <div className="grid items-center gap-1.5" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}>
        <input autoFocus value={value} disabled={busy} aria-label="Clip name"
          onChange={event => setValue(event.target.value)}
          onFocus={event => event.currentTarget.select()}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter') { event.preventDefault(); commit() }
            if (event.key === 'Escape') { event.preventDefault(); setEditing(false); setError(null) }
          }}
          className="rounded-md min-w-0"
          style={{ width: '100%', fontSize: size, color: 'var(--fg)', background: 'var(--field)', border: '1px solid var(--accent-line)', padding: '4px 7px', outline: 'none' }} />
        <button type="button" disabled={busy} onClick={commit}
          className="px-2 py-1 rounded-md"
          style={{ fontSize: 10, color: 'var(--on-accent)', background: 'var(--accent)', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(null) }}
          className="px-2 py-1 rounded-md"
          style={{ fontSize: 10, color: 'var(--muted-2)', border: '1px solid var(--edge)' }}>
          Cancel
        </button>
      </div>
      {error && <p style={{ fontSize: 10, color: 'var(--alert)', marginTop: 4 }}>{error}</p>}
    </div>
  )
}

// ── Stickman Logo ─────────────────────────────────────────────────────────────

function StickmanIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="14" cy="3.5" r="2" />
      <line x1="14" y1="5.5" x2="12" y2="11" />
      <line x1="12" y1="8" x2="8.5" y2="6.5" />
      <line x1="12" y1="8" x2="16" y2="6" />
      <line x1="12" y1="11" x2="9" y2="16" />
      <line x1="9" y1="16" x2="7" y2="14" />
      <line x1="12" y1="11" x2="15" y2="15.5" />
      <line x1="15" y1="15.5" x2="18" y2="17" />
    </svg>
  )
}

// ── Confirm Dialog ────────────────────────────────────────────────────────────

interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const accept = useCallback(() => { request.onConfirm(); onClose() }, [request, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'Enter') { e.stopPropagation(); accept() }
    }
    // Capture phase: the clip player also listens for Escape and would close
    // underneath the dialog otherwise.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [accept, onClose])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, var(--bg) 72%, transparent)', backdropFilter: 'blur(3px)', animation: 'overlay-in 0.12s ease-out' }}
      onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={request.title}
        onClick={e => e.stopPropagation()}
        className="rounded-xl"
        style={{
          width: 380, padding: 22, background: 'var(--panel)',
          border: '1px solid var(--edge)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          animation: 'dialog-in 0.14s ease-out',
        }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)', marginBottom: request.body ? 8 : 18 }}>
          {request.title}
        </h2>
        {request.body && (
          <p style={{ fontSize: 13, color: 'var(--muted-2)', lineHeight: 1.55, marginBottom: 18 }}>{request.body}</p>
        )}
        <div className="flex justify-end gap-2">
          <button autoFocus onClick={onClose}
            className="px-3.5 py-2 rounded-lg text-xs transition-all hover:brightness-125"
            style={{ color: 'var(--muted)', background: 'var(--field)', border: '1px solid var(--edge)' }}>
            Cancel
          </button>
          <button onClick={accept}
            className="px-3.5 py-2 rounded-lg text-xs transition-all hover:brightness-110"
            style={{
              fontWeight: 600,
              color: request.destructive ? 'white' : 'var(--on-accent)',
              background: request.destructive ? 'var(--alert)' : 'var(--accent)',
            }}>
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Identify Game Prompt ──────────────────────────────────────────────────────

// Shown when something is running that looks like a game but is not in the
// bundled database. Naming it once teaches Flash permanently; dismissing it
// records the executable as "not a game" so it stops asking.
function IdentifyGamePrompt({ request, onClose }: {
  request: { exe: string; suggested: string }
  onClose: (name: string | null) => void
}) {
  const [name, setName] = useState(request.suggested)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, var(--bg) 72%, transparent)', backdropFilter: 'blur(3px)', animation: 'overlay-in 0.12s ease-out' }}>
      <div role="dialog" aria-modal="true" className="rounded-xl"
        style={{ width: 420, padding: 22, background: 'var(--panel)', border: '1px solid var(--edge)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', animation: 'dialog-in 0.14s ease-out' }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>Is this a game?</h2>
        <p style={{ fontSize: 13, color: 'var(--muted-2)', lineHeight: 1.55, marginBottom: 14 }}>
          Flash does not recognise <span style={{ color: 'var(--fg)' }}>{request.exe}</span>. Name it and
          your clips will be filed under it from now on.
        </p>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onClose(name.trim()); if (e.key === 'Escape') onClose(null) }}
          className="w-full rounded-lg mb-4"
          style={{ fontSize: 13, color: 'var(--fg)', background: 'var(--field)', border: '1px solid var(--edge)', padding: '9px 11px', outline: 'none' }} />
        <div className="flex justify-end gap-2">
          <button onClick={() => onClose(null)}
            className="px-3.5 py-2 rounded-lg text-xs transition-all hover:brightness-125"
            style={{ color: 'var(--muted)', background: 'var(--field)', border: '1px solid var(--edge)' }}>
            Not a game
          </button>
          <button onClick={() => name.trim() && onClose(name.trim())} disabled={!name.trim()}
            className="px-3.5 py-2 rounded-lg text-xs transition-all hover:brightness-110"
            style={{ fontWeight: 600, color: 'var(--on-accent)', background: 'var(--accent)', opacity: name.trim() ? 1 : 0.5 }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Window Controls ───────────────────────────────────────────────────────────

// Drawn in React rather than via Electron's titleBarOverlay, which paints native
// buttons on top of whatever the app puts in its own top-right corner.
function WindowControls() {
  const Button = ({ label, onClick, path, danger }: { label: string; onClick: () => void; path: string; danger?: boolean }) => (
    <button aria-label={label} title={label} onClick={onClick}
      className="w-11 h-full flex items-center justify-center transition-colors"
      style={{ color: 'var(--muted-2)' }}
      onMouseEnter={e => {
        e.currentTarget.style.background = danger ? 'var(--alert)' : 'var(--hover)'
        e.currentTarget.style.color = danger ? 'white' : 'var(--fg)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--muted-2)'
      }}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
        <path d={path} />
      </svg>
    </button>
  )

  return (
    <div className="flex items-stretch self-stretch titlebar-no-drag" style={{ marginRight: -16 }}>
      <Button label="Minimize" onClick={() => window.flash?.minimize()} path="M0 5h10" />
      <Button label="Maximize" onClick={() => window.flash?.maximize()} path="M0.5 0.5h9v9h-9z" />
      <Button label="Close" onClick={() => window.flash?.close()} path="M0.5 0.5l9 9M9.5 0.5l-9 9" danger />
    </div>
  )
}

// ── Clip Player Modal ─────────────────────────────────────────────────────────

function ClipPlayer({ clips, startIndex, onClose, onDelete, onEdit, onRename }: {
  clips: Clip[]
  startIndex: number
  onClose: () => void
  onDelete: (clip: Clip) => void
  onEdit: (clip: Clip) => void
  onRename: (clip: Clip, name: string) => Promise<string | null>
}) {
  // Which clip is open is remembered by file, not by row number. The library
  // re-scans underneath the player — a rename, a save landing, the search box
  // narrowing — and a stored index quietly slides onto a different clip, or
  // past the end of a list that just got shorter.
  const [path, setPath] = useState(() => clips[startIndex]?.filePath ?? '')
  const lastIndex = useRef(startIndex)
  const found = clips.findIndex(entry => entry.filePath === path)
  // The tracked file can still vanish: renamed out of the current search, or
  // deleted from disk. Hold the position it had rather than jumping to the top.
  const index = found >= 0 ? found : Math.min(Math.max(lastIndex.current, 0), clips.length - 1)
  lastIndex.current = index
  const [trimNote, setTrimNote] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playerPlaying, setPlayerPlaying] = useState(false)
  const [playerTime, setPlayerTime] = useState(0)
  const [playerDuration, setPlayerDuration] = useState(0)
  const [playerVolume, setPlayerVolume] = useState(1)
  const [playerMuted, setPlayerMuted] = useState(false)
  const [frameBusy, setFrameBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportBytes, setExportBytes] = useState(10 * 1048576)   // Discord free tier
  const clip = clips[index]
  const isShot = clip?.kind === 'shot'

  const renameCurrent = useCallback(async (name: string) => {
    if (!clip) return 'Clip not found'
    const video = videoRef.current
    video?.pause()
    video?.removeAttribute('src')
    video?.load()
    const error = await onRename(clip, name)
    if (error && video) {
      video.src = clipUrl(clip.filePath)
      video.load()
    }
    return error
  }, [clip, onRename])

  // Re-anchor onto whatever is at this position after the list changed under
  // us, so the next arrow press steps from where the player actually is.
  useEffect(() => {
    if (clip && clip.filePath !== path) setPath(clip.filePath)
  }, [clip, path])

  // Clear the last export note when moving between clips, so it cannot read as
  // if it described the clip now on screen.
  useEffect(() => { setTrimNote(null) }, [index, clips])

  // The element is muted and every track is mixed natively instead. A video
  // element plays only the FIRST audio track: a clip where the game was quiet
  // but you spoke has its voice on track two, and played as complete silence.
  // Audio joins a moment after the video while the decode finishes.
  const { tracks: audioTracks } = useClipAudio(clip?.filePath ?? '')
  const unityGains = useMemo(
    () => Object.fromEntries(audioTracks.map(track => [track.id, 1])),
    [audioTracks])
  useLiveMix(videoRef, audioTracks, unityGains, playerMuted ? 0 : playerVolume)

  const togglePlayerPlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => { /* autoplay policy */ })
    else video.pause()
  }, [])

  const grabFrame = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) {
      setTrimNote('Frame is not ready')
      return
    }

    setFrameBusy(true)
    setTrimNote(null)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not create screenshot canvas')
      const playheadSeconds = video.currentTime
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve, reject) => {
        try { canvas.toBlob(resolve, 'image/png') }
        catch (error) { reject(error) }
      })
      if (!blob) throw new Error('Could not encode frame as PNG')
      if (!clip) throw new Error('Clip not found')
      const result = await window.flash?.saveClipFrame(
        clip.filePath, playheadSeconds, new Uint8Array(await blob.arrayBuffer()))
      if (!result || result.error) throw new Error(result?.error ?? 'Could not save screenshot')
      setTrimNote('Frame saved in the same folder')
    } catch (error) {
      setTrimNote(error instanceof Error ? error.message : 'Could not grab frame')
    } finally {
      setFrameBusy(false)
    }
  }, [clip?.filePath])

  const goTo = useCallback((target: number) => {
    const next = clips[Math.max(0, Math.min(target, clips.length - 1))]
    if (next) setPath(next.filePath)
  }, [clips])
  const goNext = useCallback(() => goTo(index + 1), [goTo, index])
  const goPrev = useCallback(() => goTo(index - 1), [goTo, index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') goNext()
      if (e.key === 'ArrowLeft') goPrev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goNext, goPrev])

  if (!clip) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'color-mix(in srgb, var(--bg) 97%, transparent)' }}>
      <ClipActionBar filePath={clip.filePath} onClose={onClose} onDelete={() => { onDelete(clip); onClose() }} middle={
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {index + 1} <span style={{ color: 'var(--muted-3)' }}>/ {clips.length}</span>
        </span>
      } />

      <div className="flex flex-1 overflow-hidden">
        <div className="flex items-center px-3 shrink-0">
          <button onClick={goPrev} disabled={index === 0} className="nav-arrow" aria-label="Previous clip" title="Previous clip">
            <svg width="24" height="24" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M11.25 3.75L6 9l5.25 5.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-stretch gap-4 px-4 py-4 min-h-0">
          {/* The video takes the room rather than being given a fixed ceiling,
              so the controls sit under it instead of floating in dead space.
              A video with no loaded metadata falls back to 300x150, which is
              why a clip that fails to load also looks tiny. */}
          <div className="flex-1 w-full flex items-center justify-center min-h-0">
            {isShot ? (
              <img
                key={clip.filePath}
                src={clipUrl(clip.filePath)}
                alt={clip.title}
                className="rounded-xl"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', background: '#000' }}
              />
            ) : (
              <video
                ref={videoRef}
                key={clip.filePath}
                src={clipUrl(clip.filePath)}
                autoPlay
                muted
                className="rounded-xl"
                style={{ maxWidth: '100%', maxHeight: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
                onLoadedMetadata={event => setPlayerDuration(event.currentTarget.duration || clip.durationSec || 0)}
                onTimeUpdate={event => setPlayerTime(event.currentTarget.currentTime)}
                onPlay={() => setPlayerPlaying(true)}
                onPause={() => setPlayerPlaying(false)}
                onClick={togglePlayerPlay}
              />
            )}
          </div>

          {!isShot && <>
            <PlayerControls
              playing={playerPlaying}
              currentSec={playerTime}
              durationSec={playerDuration}
              volume={playerVolume}
              muted={playerMuted}
              onTogglePlay={togglePlayerPlay}
              onSeek={seconds => {
                const video = videoRef.current
                if (video) video.currentTime = seconds
                setPlayerTime(seconds)
              }}
              onVolume={next => { setPlayerVolume(next); setPlayerMuted(next === 0) }}
              onToggleMute={() => setPlayerMuted(m => !m)}
            />
            <div className="w-full flex items-center gap-3" style={{ maxWidth: 900 }}>
            {/* Trimming moved to its own screen. Two number boxes were never a
                way to pick a moment. */}
            <button onClick={() => onEdit(clip)}
              className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5 shrink-0"
              style={{ color: 'var(--muted-2)', border: '1px solid var(--edge-soft)' }}>
              Editor
            </button>

            <button disabled={frameBusy} onClick={grabFrame}
              className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5 shrink-0"
              style={{ color: 'var(--muted-2)', border: '1px solid var(--edge-soft)', opacity: frameBusy ? 0.5 : 1 }}>
              {frameBusy ? 'Saving…' : 'Grab frame'}
            </button>

            {/* Capture stays archival-quality; this makes a small sibling that
                actually fits an upload limit. Unlike Trim this re-encodes, so it
                takes seconds rather than milliseconds. */}
            <button disabled={exportBusy}
              title={`Make a copy under ${Math.round(exportBytes / 1048576)}MB so it can be sent in Discord`}
              onClick={async () => {
                setExportBusy(true); setTrimNote(null)
                const r = await window.flash?.exportClip(clip.filePath, exportBytes)
                setExportBusy(false)
                if (!r || r.error) { setTrimNote(r?.error ?? 'Export failed'); return }
                setTrimNote(`Shareable copy: ${formatBytes(r.bytes ?? 0)} at ${r.height}p — in the same folder`)
              }}
              className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5 shrink-0"
              style={{ color: 'var(--muted-2)', border: '1px solid var(--edge-soft)', opacity: exportBusy ? 0.5 : 1 }}>
              {exportBusy ? 'Compressing…' : 'Export for sharing'}
            </button>
            <Dropdown
              value={exportBytes}
              onChange={setExportBytes}
              title="Upload limit to fit under"
              options={EXPORT_LIMITS}
            />
            {trimNote && <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>{trimNote}</span>}
            </div>
          </>}

          <div className="w-full flex items-start justify-between" style={{ maxWidth: 900 }}>
            <div>
              <div style={{ marginBottom: 4 }}>
                <RenameTitle title={clip.title} display={clipDisplayTitle(clip.title)} onCommit={renameCurrent} size={16} />
              </div>
              <div className="flex items-center gap-3" style={{ color: 'var(--muted-2)', fontSize: 12 }}>
                <span style={{ color: 'var(--accent)' }}>{clip.game}</span>
                <span>·</span>
                <span>{formatBytes(clip.size)}</span>
                <span>·</span>
                <span>{timeAgo(clip.createdAt)}</span>
              </div>
            </div>
            <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>← → Esc</span>
          </div>
        </div>

        <div className="flex items-center px-3 shrink-0">
          <button onClick={goNext} disabled={index === clips.length - 1} className="nav-arrow" aria-label="Next clip" title="Next clip">
            <svg width="24" height="24" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M6.75 3.75L12 9l-5.25 5.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── TopBar ─────────────────────────────────────────────────────────────────────

function TopBar({ active, setActive, isRecording, onToggleRecording, detectedGame, captureAvailable, hotkey, saveState }: {
  active: string
  setActive: (c: string) => void
  isRecording: boolean
  onToggleRecording: () => void
  detectedGame: string | null
  captureAvailable: boolean
  hotkey: string
  saveState: { saving: boolean; error?: string }
}) {
  return (
    <header className="flex items-center shrink-0 px-4 titlebar-drag" style={{ height: 48, background: 'var(--panel)', borderBottom: '1px solid var(--edge-soft)' }}>
      <div className="flex items-center gap-2 mr-6 titlebar-no-drag">
        <div style={{ color: 'var(--accent)' }}><StickmanIcon size={20} /></div>
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
          flash<span style={{ color: 'var(--accent)' }}>.</span>
        </span>
      </div>

      <nav className="flex items-stretch h-full titlebar-no-drag">
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActive(tab)}
            className="relative px-4 transition-colors duration-100"
            style={{ fontWeight: active === tab ? 500 : 400, fontSize: 13, color: active === tab ? 'var(--fg)' : 'var(--muted-2)', borderBottom: `2px solid ${active === tab ? 'var(--accent)' : 'transparent'}` }}>
            {tab}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-3 titlebar-no-drag">
        {saveState.saving && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md"
            style={{ background: 'var(--accent-wash)', border: '1px solid var(--accent-line)' }}>
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)', animation: 'pulse-red 0.8s ease-in-out infinite' }} />
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>Saving clip…</span>
          </div>
        )}
        {saveState.error && !saveState.saving && (
          <div className="px-2 py-1 rounded-md" title={saveState.error}
            style={{ background: 'transparent', border: '1px solid var(--alert)', maxWidth: 280 }}>
            <span style={{ fontSize: 11, color: 'var(--alert)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
              {saveState.error}
            </span>
          </div>
        )}

        {detectedGame && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md" style={{ background: 'var(--edge-soft)', border: '1px solid var(--edge-soft)' }}>
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--ok)' }} />
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{detectedGame}</span>
          </div>
        )}

        <button onClick={onToggleRecording} disabled={!captureAvailable}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all"
          title={captureAvailable ? (isRecording ? 'Stop replay buffer' : 'Start replay buffer') : 'Capture engine unavailable'}
          style={{
            background: isRecording ? 'var(--accent-wash)' : 'var(--edge-soft)',
            border: `1px solid ${isRecording ? 'var(--accent-line)' : 'var(--edge-soft)'}`,
            cursor: captureAvailable ? 'pointer' : 'not-allowed',
            opacity: captureAvailable ? 1 : 0.5,
          }}>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: isRecording ? 'var(--accent)' : 'var(--muted-3)', animation: isRecording ? 'pulse-red 1.4s ease-in-out infinite' : 'none' }} />
          <span style={{ fontSize: 11, color: isRecording ? 'var(--accent)' : 'var(--muted-2)', fontWeight: 500 }}>
            {isRecording ? 'REC' : 'IDLE'}
          </span>
        </button>

        <kbd style={{ fontSize: 11, color: 'var(--muted-3)', background: 'var(--field)', border: '1px solid var(--edge)', borderRadius: 4, padding: '2px 6px' }}>{hotkey}</kbd>

        <WindowControls />
      </div>
    </header>
  )
}

// ── Sidebar (My Clips only) ────────────────────────────────────────────────────

function Sidebar({ games, gameFilter, setGameFilter, storage, onOpenFolder }: {
  games: { name: string; count: number }[]
  gameFilter: string
  setGameFilter: (g: string) => void
  storage: { used: number; clips: number }
  onOpenFolder: () => void
}) {
  return (
    <aside className="flex flex-col shrink-0 overflow-y-auto" style={{ width: 196, background: 'var(--bg)', borderRight: '1px solid var(--edge-soft)' }}>
      <div className="p-3">
        <button onClick={onOpenFolder}
          className="w-full py-2 rounded-lg transition-all hover:brightness-110 active:scale-95 mb-4"
          style={{ fontWeight: 600, fontSize: 13, background: 'var(--accent)', color: 'var(--on-accent)' }}>
          Open Clips Folder
        </button>

        <p style={{ fontSize: 10, fontWeight: 600, color: 'var(--faint)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 8 }}>Games</p>

        {games.length === 0 ? (
          <p style={{ fontSize: 11, color: 'var(--faint)', padding: '8px 12px', lineHeight: 1.5 }}>
            No clips yet. Games appear here once you clip them.
          </p>
        ) : (
          games.map(g => (
            <button key={g.name} onClick={() => setGameFilter(g.name)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all duration-100 text-left mb-0.5"
              style={{ background: gameFilter === g.name ? 'var(--accent-wash)' : 'transparent', color: gameFilter === g.name ? 'var(--fg)' : 'var(--muted-2)' }}>
              <span style={{ fontSize: 13, fontWeight: gameFilter === g.name ? 500 : 400 }}>{g.name}</span>
              <span style={{ fontSize: 11, color: 'var(--faint)' }}>{g.count}</span>
            </button>
          ))
        )}

        <div style={{ height: 1, background: 'var(--edge-soft)', margin: '12px 0' }} />

        <p style={{ fontSize: 10, fontWeight: 600, color: 'var(--faint)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 8 }}>Storage</p>
        <div className="px-3 pb-1">
          <div className="flex justify-between mb-1">
            <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>{formatBytes(storage.used)}</span>
            <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>{storage.clips} clip{storage.clips === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

// ── ClipCard ───────────────────────────────────────────────────────────────────

function ClipCard({ clip, selected, onClick, onToggle, onDelete, onRename, suspend }: {
  clip: Clip
  selected: boolean
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void
  onToggle: () => void
  onDelete: () => void
  onRename: (clip: Clip, name: string) => Promise<string | null>
  suspend: boolean
}) {
  const [hov, setHov] = useState(false)
  const [visible, setVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const commitRename = async (name: string) => {
    const video = videoRef.current
    video?.pause()
    video?.removeAttribute('src')
    video?.load()
    const error = await onRename(clip, name)
    if (error && video) {
      video.src = `${clipUrl(clip.filePath)}#t=0.5`
      video.load()
    }
    return error
  }

  // Each thumbnail is a real <video> decoding a frame off disk. Mounting one per
  // clip means a library of 200 spins up 200 decoders at once, so hold the src
  // back until the card is actually near the viewport — and give it back once
  // the card leaves. Disconnecting on first sight instead meant every card ever
  // scrolled past kept its decoder for the life of the session, so a long scroll
  // through a big library ended with the newest thumbnails painting black:
  // Chromium caps concurrent decodes and drops the excess without an error.
  useEffect(() => {
    const node = cardRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '300px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={cardRef}
      // Native OS drag: drop the tile straight into Discord. preventDefault stops
      // Chromium starting its own (useless) HTML drag first.
      draggable
      onDragStart={e => { e.preventDefault(); window.flash?.startClipDrag(clip.filePath) }}
      className="rounded-xl overflow-hidden cursor-pointer transition-all duration-150 relative"
      style={{ background: 'var(--panel)', border: `1px solid ${selected ? 'var(--accent)' : hov ? 'var(--accent-line)' : 'var(--edge-soft)'}`, transform: hov ? 'translateY(-1px)' : 'none', boxShadow: selected ? '0 0 0 1px var(--accent-line)' : hov ? '0 4px 20px rgba(0,0,0,0.5)' : 'none' }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onClick}>
      <div className="relative overflow-hidden" style={{ aspectRatio: '16/9', background: 'var(--bg)' }}>
        {/* Cards behind an open player or editor stay in the viewport, so
            without `suspend` their decoders stay alive underneath and the
            screen on top runs out. Chromium caps concurrent video decode, and
            past the cap elements simply paint black with no error. */}
        {clip.kind === 'shot' ? (
          <img
            src={clipUrl(clip.filePath)}
            alt=""
            loading="lazy"
            draggable={false}
            className="w-full h-full object-cover"
            style={{ pointerEvents: 'none' }}
          />
        ) : visible && !suspend && (
          <video
            ref={videoRef}
            src={`${clipUrl(clip.filePath)}#t=0.5`}
            preload="metadata"
            muted
            className="w-full h-full object-cover"
            style={{ pointerEvents: 'none' }}
          />
        )}
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
          {clip.kind === 'shot' ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label="Image">
              <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="var(--muted)"/>
              <circle cx="8" cy="4" r="1" fill="var(--muted)"/>
              <path d="M2.5 9l2.25-2.5L6.5 8l1.25-1.25L10 9" stroke="var(--muted)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{clip.duration}</span>
          )}
        </div>
        <input
          type="checkbox"
          checked={selected}
          readOnly
          draggable={false}
          aria-label={`${selected ? 'Deselect' : 'Select'} ${clip.title}`}
          onClick={event => { event.stopPropagation(); onToggle() }}
          className="absolute bottom-2 left-2 transition-opacity"
          style={{
            width: 17, height: 17, opacity: selected || hov ? 1 : 0,
            pointerEvents: selected || hov ? 'auto' : 'none', cursor: 'pointer', accentColor: 'var(--accent)',
          }}
        />
        {hov && (
          <>
            {/* Decorative only, and transparent to clicks. It covers the whole
                tile and renders after the checkbox, so without this it eats the
                checkbox's click and the card opens instead of selecting. The
                delete button is a sibling, not a child, so it is unaffected. */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ background: 'rgba(0,0,0,0.35)' }}>
              <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'var(--accent)', boxShadow: '0 0 20px var(--accent-line)' }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><polygon points="3,1 11,6.5 3,12" fill="white"/></svg>
              </div>
            </div>
            <button
              onClick={e => { e.stopPropagation(); onDelete() }}
              className="absolute top-2 right-2 w-6 h-6 rounded flex items-center justify-center transition-all hover:bg-red-500/20"
              style={{ background: 'rgba(0,0,0,0.6)', color: 'var(--alert)' }}>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </>
        )}
        <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid var(--edge-soft)' }}>
          <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--muted)' }}>{clip.game}</span>
        </div>
      </div>
      <div className="p-3">
        <div style={{ marginBottom: 6, lineHeight: 1.4 }}>
          <RenameTitle title={clip.title} display={clipDisplayTitle(clip.title)} onCommit={commitRename} />
        </div>
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>{formatBytes(clip.size)}</span>
          <span style={{ fontSize: 10, color: 'var(--faint)' }}>{timeAgo(clip.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}

// ── ClipsPanel ─────────────────────────────────────────────────────────────────

function ClipsPanel({ clips, query, onQueryChange, shortcutsEnabled, selectedIds, onToggleSelection, onSelectRange, onSelectAll, onClearSelection, onOpenClip, onDeleteClip, onRenameClip, isRecording, captureAvailable, hotkey, bufferLength, suspendThumbnails }: {
  clips: Clip[]
  query: string
  onQueryChange: (query: string) => void
  shortcutsEnabled: boolean
  selectedIds: ReadonlySet<string>
  onToggleSelection: (id: string) => void
  onSelectRange: (displayedIds: readonly string[], targetId: string) => void
  onSelectAll: (displayedIds: readonly string[]) => void
  onClearSelection: () => void
  onOpenClip: (clip: Clip) => void
  onDeleteClip: (clip: Clip) => void
  onRenameClip: (clip: Clip, name: string) => Promise<string | null>
  isRecording: boolean
  captureAvailable: boolean
  hotkey: string
  bufferLength: number
  suspendThumbnails: boolean
}) {
  const [sort, setSort] = useState<'Recent' | 'Longest' | 'Largest'>('Recent')
  const searchRef = useRef<HTMLInputElement>(null)

  const sorted = useMemo(() => [...clips].sort((a, b) => {
    if (sort === 'Longest') return b.durationSec - a.durationSec
    if (sort === 'Largest') return b.size - a.size
    return b.createdAt - a.createdAt
  }), [clips, sort])
  const displayedIds = useMemo(() => sorted.map(clip => clip.id), [sorted])

  useEffect(() => {
    if (!shortcutsEnabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const textInput = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      if (textInput) return

      if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        onSelectAll(displayedIds)
      } else if (event.key === 'Escape' && selectedIds.size > 0) {
        event.preventDefault()
        onClearSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [displayedIds, onClearSelection, onSelectAll, selectedIds.size, shortcutsEnabled])

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-1.5">
          {(['Recent', 'Longest', 'Largest'] as const).map(s => (
            <button key={s} onClick={() => setSort(s)}
              className="px-3 py-1.5 rounded-lg text-xs transition-all duration-100"
              style={{ fontWeight: sort === s ? 500 : 400, background: sort === s ? 'var(--accent-wash)' : 'var(--edge-soft)', color: sort === s ? 'var(--fg)' : 'var(--muted-2)', border: `1px solid ${sort === s ? 'var(--accent-line)' : 'var(--edge-soft)'}` }}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={searchRef}
            type="text"
            aria-label="Search clips"
            placeholder="Search clips  /"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              onQueryChange('')
              event.currentTarget.blur()
            }}
            className="rounded-lg"
            style={{ width: 190, fontSize: 12, color: 'var(--muted)', background: 'var(--field)', border: '1px solid var(--edge)', padding: '7px 10px', outline: 'none' }}
          />
          <span style={{ fontSize: 11, color: 'var(--faint)', whiteSpace: 'nowrap' }}>{clips.length} clip{clips.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      {clips.length === 0 ? (
        query ? (
          <div className="flex flex-col items-center justify-center gap-3" style={{ minHeight: 300 }}>
            <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--muted-2)' }}>No clips match</p>
            <button
              onClick={() => onQueryChange('')}
              className="px-3 py-1.5 rounded-lg text-xs transition-all duration-100"
              style={{ color: 'var(--accent)', background: 'var(--field)', border: '1px solid var(--edge)' }}>
              Clear search
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3" style={{ minHeight: 300 }}>
            <div style={{ color: 'var(--edge)' }}><StickmanIcon size={48} /></div>
            <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--muted-2)' }}>No clips yet</p>
            <p style={{ fontSize: 13, color: 'var(--muted-3)', textAlign: 'center', maxWidth: 380, lineHeight: 1.6 }}>
              {!captureAvailable
                ? 'Capture engine unavailable. Check that the native addon is built.'
                : isRecording
                  ? <>Replay buffer is running. Press <kbd style={{ background: 'var(--field)', border: '1px solid var(--accent-line)', borderRadius: 4, padding: '1px 6px', color: 'var(--accent)', fontSize: 12 }}>{hotkey}</kbd> to save the last {bufferLength} seconds.</>
                  : `Click the IDLE badge in the top bar to start the replay buffer, then press ${hotkey} to clip.`}
            </p>
          </div>
        )
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {sorted.map(clip => (
            <ClipCard
              key={clip.id}
              clip={clip}
              selected={selectedIds.has(clip.id)}
              onClick={event => {
                if (event.shiftKey) {
                  event.preventDefault()
                  onSelectRange(displayedIds, clip.id)
                } else if (event.ctrlKey || event.metaKey) {
                  event.preventDefault()
                  onToggleSelection(clip.id)
                } else onOpenClip(clip)
              }}
              onToggle={() => onToggleSelection(clip.id)}
              onDelete={() => onDeleteClip(clip)}
              onRename={onRenameClip}
              suspend={suspendThumbnails}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Hotkey Input ──────────────────────────────────────────────────────────────

function HotkeyInput({ value, registered, onChange }: {
  value: string
  registered: boolean
  onChange: (accelerator: string) => void
}) {
  const [listening, setListening] = useState(false)

  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setListening(false); return }
      const accelerator = toAccelerator(e)
      if (!accelerator) return   // keep listening through bare modifiers
      onChange(accelerator)
      setListening(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, onChange])

  const failed = !registered && !listening
  return (
    <button onClick={() => setListening(l => !l)}
      title={failed ? 'Another program already owns this key — pick a different one' : 'Click, then press a key'}
      className="px-2.5 py-1 rounded transition-all"
      style={{
        fontSize: 11, minWidth: 96,
        color: listening ? 'var(--fg)' : failed ? 'var(--alert)' : 'var(--accent)',
        background: listening ? 'var(--field)' : failed ? 'transparent' : 'var(--accent-wash)',
        border: `1px solid ${listening ? 'var(--accent)' : failed ? 'var(--alert)' : 'var(--accent-line)'}`,
      }}>
      {listening ? 'Press a key…' : failed ? `${value} — in use` : value}
    </button>
  )
}

// ── Toggle ─────────────────────────────────────────────────────────────────────

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="relative w-8 h-4 rounded-full transition-all duration-150 shrink-0"
      style={{ background: on ? 'var(--accent)' : 'var(--edge-soft)', border: `1px solid ${on ? 'var(--accent)' : 'var(--edge-soft)'}` }}>
      <div className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all duration-150" style={{ left: on ? 'calc(100% - 14px)' : '1px' }} />
    </button>
  )
}

// ── SettingsPanel ──────────────────────────────────────────────────────────────

interface CaptureHealth {
  healthy: boolean
  fps: number
  buffered: number
  audioMode?: string
  error?: string
}

interface VoiceStatus {
  available: boolean
  language: string
  error: string
}

// Defined at module scope on purpose. Declared inside SettingsPanel these were
// a new component type on every render, so React tore the whole settings tree
// down and built it again - and the status poll re-renders every two seconds.
// Anything holding its own state below a Row lost it on that tick: an open
// dropdown closed by itself before you could pick from it.
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 gap-4" style={{ borderBottom: '1px solid var(--edge-soft)' }}>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
      {children}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--edge-soft)' }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{title}</p>
      {children}
    </div>
  )
}

function SettingsPanel({ settings, onChange, storage, encoder, captureBackend, voiceStatus, hotkeysRegistered, displays, health, learnedGames, onForgetGame, onOpenFolder, onPickFolder }: {
  settings: Settings
  onChange: (partial: Partial<Settings>) => void
  storage: { used: number; clips: number }
  encoder: string
  captureBackend: string
  voiceStatus: VoiceStatus
  hotkeysRegistered: { clip: boolean; short: boolean; screenshot: boolean }
  displays: Display[]
  health: CaptureHealth | null
  learnedGames: Record<string, string>
  onForgetGame: (exe: string) => void
  onOpenFolder: () => void
  onPickFolder: () => void
}) {
  // The ceiling for a useful frame rate is the refresh rate of the display
  // actually being captured, not the fastest one attached.
  const activeRefreshHz = displays.find(d => d.id === settings.displayId)?.refreshHz ?? 0
  const customPhraseSyllables = countSyllables(settings.voicePhrase)
  const customPhraseTooShort = settings.voicePhrase.trim().length > 0 && customPhraseSyllables < 3

  const updateGameOverride = (
    game: string,
    field: 'quality' | 'bufferLength',
    value: string | number | undefined,
  ) => {
    const perGame = { ...settings.perGame }
    const override = { ...perGame[game] }
    if (field === 'quality') {
      if (value === undefined) delete override.quality
      else override.quality = String(value)
    } else {
      if (value === undefined) delete override.bufferLength
      else override.bufferLength = Number(value)
    }
    if (Object.keys(override).length) perGame[game] = override
    else delete perGame[game]
    onChange({ perGame })
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 style={{ fontWeight: 600, fontSize: 18, color: 'var(--fg)', marginBottom: 2 }}>Settings</h1>
      <p style={{ fontSize: 13, color: 'var(--muted-3)', marginBottom: 24 }}>Configure your Flash recording preferences</p>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
        <Card title="Appearance">
          <div className="grid gap-2 pt-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {Object.entries(THEMES).map(([key, theme]) => {
              const selected = settings.theme === key
              return (
                <button key={key} onClick={() => onChange({ theme: key })}
                  aria-pressed={selected}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all text-left"
                  style={{
                    background: selected ? 'var(--accent-wash)' : 'var(--field)',
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--edge)'}`,
                  }}>
                  {/* Swatch previews the target palette, not the active one. */}
                  <span className="flex shrink-0 rounded-md overflow-hidden" style={{ border: `1px solid ${theme.edge}` }}>
                    <span style={{ width: 12, height: 22, background: theme.bg }} />
                    <span style={{ width: 12, height: 22, background: theme.panel }} />
                    <span style={{ width: 12, height: 22, background: theme.accent }} />
                  </span>
                  <span style={{ fontSize: 12, color: selected ? 'var(--fg)' : 'var(--muted-2)', fontWeight: selected ? 500 : 400 }}>
                    {theme.label}
                  </span>
                </button>
              )
            })}
          </div>
        </Card>

        <Card title="Capture">
          <Row label={`Clip hotkey — full ${settings.bufferLength}s`}>
            <HotkeyInput value={settings.hotkey} registered={hotkeysRegistered.clip}
              onChange={hotkey => onChange({ hotkey })} />
          </Row>
          <Row label={`Short clip hotkey — last ${Math.min(settings.shortClipSeconds, settings.bufferLength)}s`}>
            <HotkeyInput value={settings.hotkeyShort} registered={hotkeysRegistered.short}
              onChange={hotkeyShort => onChange({ hotkeyShort })} />
          </Row>
          <Row label="Screenshot hotkey">
            <HotkeyInput value={settings.screenshotHotkey} registered={hotkeysRegistered.screenshot}
              onChange={screenshotHotkey => onChange({ screenshotHotkey })} />
          </Row>
          <Row label="Short clip length">
            {/* A short clip cannot be longer than the buffer it is cut from.
                Allowing it made the row above claim "last 60s" when there were
                only 15 seconds in the buffer to save. */}
            <input type="range" min={5} max={Math.max(5, settings.bufferLength)} step={5}
              value={Math.min(settings.shortClipSeconds, settings.bufferLength)}
              onChange={e => onChange({ shortClipSeconds: +e.target.value })}
              style={{ accentColor: 'var(--accent)', width: 120 }} />
          </Row>
          {displays.length > 1 && (
            <Row label="Capture display">
              <Dropdown
                value={settings.displayId}
                onChange={displayId => onChange({ displayId })}
                width={210}
                options={displays.map(d => ({
                  value: d.id,
                  label: `Display ${d.id + 1} — ${d.width}x${d.height}`,
                  hint: [d.refreshHz ? `${d.refreshHz}Hz` : '', d.isPrimary ? 'primary' : '']
                    .filter(Boolean).join(' · ') || undefined,
                }))}
              />
            </Row>
          )}
          <Row label="Quality">
            <div className="flex items-center gap-2">
              {/* Capture cannot make more distinct frames than the display
                  refreshes; above that you get duplicates at a higher bitrate.
                  Say so rather than letting the setting quietly lie. */}
              {activeRefreshHz > 0 && qualityFps(settings.quality) > activeRefreshHz && (
                <span title={`Your display runs at ${activeRefreshHz}Hz, so frames above that are duplicates.`}
                  style={{ fontSize: 11, color: 'var(--spark)' }}>
                  above {activeRefreshHz}Hz
                </span>
              )}
              <Dropdown
                value={settings.quality}
                onChange={quality => onChange({ quality })}
                options={QUALITY_OPTIONS.map(q => ({
                  value: q,
                  label: q,
                  hint: activeRefreshHz > 0 && qualityFps(q) > activeRefreshHz ? 'over refresh' : undefined,
                }))}
                width={150}
              />
            </div>
          </Row>
          <Row label={`Buffer length — ${settings.bufferLength}s`}>
            <input type="range" min={10} max={300} step={5} value={settings.bufferLength}
              onChange={e => onChange({ bufferLength: +e.target.value })}
              style={{ accentColor: 'var(--accent)', width: 120 }} />
          </Row>
          <Row label="Audio capture">
            <Toggle on={settings.audioCapture} onChange={() => onChange({ audioCapture: !settings.audioCapture })} />
          </Row>
          <Row label="Encoder">
            <span style={{ fontSize: 12, color: encoder === 'none' ? 'var(--alert)' : 'var(--ok)' }}>{encoder}</span>
          </Row>
          {/* Desktop Duplication cannot see a fullscreen game and records it as
              a near-black picture. Saying which backend is running turns that
              from a mystery into a one-line answer. */}
          <Row label="Screen capture">
            <span style={{ fontSize: 12, color: captureBackend === 'Desktop Duplication' ? 'var(--spark)' : 'var(--ok)' }}
              title={captureBackend === 'Desktop Duplication'
                ? 'Fullscreen games may record black. Windows.Graphics.Capture was unavailable.'
                : 'Records fullscreen games correctly.'}>
              {captureBackend}
            </span>
          </Row>
          {/* The engine already measures all of this; it was just never shown.
              Every silent-failure class in the app is visible in these numbers. */}
          {health && (
            <Row label="Capture health">
              <span style={{ fontSize: 12, color: health.healthy ? 'var(--ok)' : 'var(--alert)' }}>
                {health.healthy
                  ? `${health.fps.toFixed(0)} fps · ${health.buffered.toFixed(0)}s buffered${health.audioMode ? ` · audio ${health.audioMode}` : ''}`
                  : health.error || 'capture stopped'}
              </span>
            </Row>
          )}
        </Card>

        <Card title="Voice activation">
          {!voiceStatus.available ? (
            <p style={{ fontSize: 12, color: 'var(--alert)', paddingTop: 12, lineHeight: 1.5 }}>
              {voiceStatus.error || 'Voice activation is unavailable.'}
            </p>
          ) : (
            <>
              <Row label="Listen to the microphone while Flash is open">
                <Toggle on={settings.voiceEnabled}
                  onChange={() => onChange({ voiceEnabled: !settings.voiceEnabled })} />
              </Row>
              <Row label="Listening device">
                <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>Windows default input device</span>
              </Row>
              <Row label="Speech language">
                <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>{voiceStatus.language}</span>
              </Row>
              <Row label="Custom full-clip phrase">
                <div style={{ width: 220 }}>
                  <input
                    type="text"
                    aria-label="Custom full-clip voice phrase"
                    placeholder="Optional phrase"
                    value={settings.voicePhrase}
                    onChange={event => onChange({ voicePhrase: event.target.value })}
                    className="rounded-lg"
                    style={{ width: '100%', fontSize: 12, color: 'var(--fg)', background: 'var(--field)', border: '1px solid var(--edge)', padding: '7px 10px', outline: 'none' }}
                  />
                  {customPhraseTooShort && (
                    <p style={{ fontSize: 11, color: 'var(--spark)', paddingTop: 5, lineHeight: 1.4 }}>
                      Use at least three syllables. Short phrases can collide with ordinary speech.
                    </p>
                  )}
                </div>
              </Row>
              <p style={{ fontSize: 11, color: 'var(--muted-3)', paddingTop: 12, lineHeight: 1.5 }}>
                Built in: “flash clip that”, “flash clip short”, and “flash screenshot”.
              </p>
            </>
          )}
        </Card>

        <Card title="Games">
          <p style={{ fontSize: 11, color: 'var(--muted-3)', paddingTop: 10, lineHeight: 1.5 }}>
            Names you have taught Flash. These are used alongside the built-in list to
            decide which game a clip belongs to.
          </p>
          {Object.keys(learnedGames).length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--muted-3)', paddingTop: 10 }}>
              Nothing taught yet — Flash recognises {52} games on its own.
            </p>
          ) : (
            <div className="pt-2">
              {Object.entries(learnedGames).map(([exe, name]) => {
                const override = settings.perGame[name] ?? {}
                const effective = resolveGameSettings(settings.perGame, name, settings)
                return (
                  <div key={exe} className="py-2" style={{ borderBottom: '1px solid var(--edge-soft)' }}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate" style={{ fontSize: 12, color: 'var(--fg)' }}>
                        {name} <span style={{ color: 'var(--muted-3)' }}>· {exe}</span>
                      </span>
                      <button onClick={() => onForgetGame(exe)}
                        title="Forget this name"
                        className="px-2 py-1 rounded transition-all hover:bg-white/5 shrink-0"
                        style={{ fontSize: 11, color: 'var(--muted-2)', border: '1px solid var(--edge)' }}>
                        Forget
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                      <span style={{ width: 42, fontSize: 10, color: 'var(--muted-3)' }}>Quality</span>
                      <Dropdown
                        value={override.quality ?? ''}
                        onChange={quality => updateGameOverride(name, 'quality', quality || undefined)}
                        width={190}
                        options={[
                          { value: '', label: `${effective.quality} · inherited` },
                          ...QUALITY_OPTIONS.map(quality => ({ value: quality, label: `${quality} · set` })),
                        ]}
                      />
                      <span style={{ width: 38, fontSize: 10, color: 'var(--muted-3)' }}>Length</span>
                      <Dropdown
                        value={override.bufferLength ?? 0}
                        onChange={bufferLength => updateGameOverride(name, 'bufferLength', bufferLength || undefined)}
                        width={130}
                        options={[
                          { value: 0, label: `${effective.bufferLength}s · inherited` },
                          ...Array.from({ length: 59 }, (_, index) => 10 + index * 5)
                            .map(bufferLength => ({ value: bufferLength, label: `${bufferLength}s · set` })),
                        ]}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card title="Notifications">
          <Row label="Clip saved notification">
            <Toggle on={settings.notifications} onChange={() => onChange({ notifications: !settings.notifications })} />
          </Row>
          <Row label="In-game overlay">
            <Toggle on={settings.overlay} onChange={() => onChange({ overlay: !settings.overlay })} />
          </Row>
          {settings.overlay && (
            <Row label="Overlay corner">
              <Dropdown
                value={settings.overlayPosition}
                onChange={overlayPosition => onChange({ overlayPosition: overlayPosition as Settings['overlayPosition'] })}
                width={140}
                options={[
                  { value: 'top-left', label: 'Top left' },
                  { value: 'top-right', label: 'Top right' },
                  { value: 'bottom-left', label: 'Bottom left' },
                  { value: 'bottom-right', label: 'Bottom right' },
                ]}
              />
            </Row>
          )}
          <p style={{ fontSize: 11, color: 'var(--muted-3)', paddingTop: 12, lineHeight: 1.5 }}>
            The overlay shows recording status while a game is running, and draws over
            borderless and windowed games. It does not hook into the game, so it is safe
            with anti-cheat — but for the same reason it cannot draw over true
            exclusive-fullscreen. Switch a game to borderless if you do not see it.
          </p>
        </Card>

        <Card title="Storage">
          <div className="mb-4 pt-2">
            <div className="flex justify-between mb-1">
              <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>{formatBytes(storage.used)} used</span>
              <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>{storage.clips} clip{storage.clips === 1 ? '' : 's'}</span>
            </div>
          </div>
          <Row label="Clips folder">
            <button onClick={onPickFolder}
              className="px-2 py-1 rounded transition-all hover:bg-white/5"
              style={{ fontSize: 11, color: 'var(--muted-2)', border: '1px solid var(--edge-soft)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={settings.clipsFolder}>
              {settings.clipsFolder}
            </button>
          </Row>
          <Row label="Auto-delete clips after">
            <Dropdown
              value={settings.autoDeleteDays}
              onChange={autoDeleteDays => onChange({ autoDeleteDays })}
              width={120}
              options={[
                { value: 0, label: 'Never' },
                { value: 7, label: '7 days' },
                { value: 30, label: '30 days' },
                { value: 90, label: '90 days' },
              ]}
            />
          </Row>
          <Row label="Format"><span style={{ fontSize: 12, color: 'var(--muted-2)' }}>MP4 / H.264</span></Row>
          <button onClick={onOpenFolder}
            className="mt-4 w-full py-2 rounded-lg text-xs transition-all hover:brightness-110"
            style={{ fontWeight: 600, background: 'var(--accent)', color: 'var(--on-accent)' }}>
            Open Clips Folder
          </button>
        </Card>
      </div>
    </div>
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [active, setActive] = useState('My Clips')
  const [gameFilter, setGameFilter] = useState('All')
  const [clipQuery, setClipQuery] = useState('')
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [editingClip, setEditingClip] = useState<Clip | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [detectedGame, setDetectedGame] = useState<string | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const selectionAnchor = useRef<string | null>(null)
  const [storage, setStorage] = useState({ used: 0, clips: 0 })
  const [settings, setSettings] = useState<Settings>({
    clipsFolder: '', theme: DEFAULT_THEME, hotkey: 'F8', hotkeyShort: 'Shift+F8', screenshotHotkey: 'F9',
    shortClipSeconds: 15, displayId: 0, overlay: true, overlayPosition: 'top-left',
    voiceEnabled: false, voicePhrase: '', voiceRawFloor: 0.5, voiceCooldownMs: 3000,
    quality: '1080p 60fps', bufferLength: 30,
    audioCapture: true, autoSave: true, notifications: true, autoDeleteDays: 0,
    perGame: {},
  })
  const [encoder, setEncoder] = useState('none')
  const [captureBackend, setCaptureBackend] = useState('unknown')
  const [captureAvailable, setCaptureAvailable] = useState(false)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  // All three keys, so a secondary hotkey lost to another app is visible in
  // Settings instead of looking fine and doing nothing.
  const [hotkeysRegistered, setHotkeysRegistered] = useState(
    { hotkey: '', clip: true, short: true, screenshot: true })
  const [identifyRequest, setIdentifyRequest] = useState<{ exe: string; suggested: string } | null>(null)
  const [health, setHealth] = useState<CaptureHealth | null>(null)
  const [learnedGames, setLearnedGames] = useState<Record<string, string>>({})
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    available: false,
    language: '',
    error: 'Checking voice activation…',
  })

  // Poll only while Settings is open — a background timer for a panel nobody is
  // looking at is exactly the kind of idle cost this app exists to avoid.
  useEffect(() => {
    if (active !== 'Settings' || !window.flash) return
    let cancelled = false
    const read = async () => {
      const [captureStatus, voice] = await Promise.all([
        window.flash!.capture.getStatus(),
        window.flash!.getVoiceStatus(),
      ])
      if (cancelled) return
      const s: any = captureStatus
      setVoiceStatus(voice)
      setHealth({
        healthy: s.captureHealthy !== false && s.recording !== false,
        fps: s.lastIntervalMs > 0 ? 1000 / s.lastIntervalMs : 0,
        buffered: s.bufferSeconds ?? 0,
        audioMode: s.audioMode,
        error: s.captureError,
      })
      if (s.encoder) setEncoder(s.encoder)
      if (s.captureBackend) setCaptureBackend(s.captureBackend)
    }
    read()
    const timer = setInterval(read, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [active])
  const [displays, setDisplays] = useState<Display[]>([])
  const [saveState, setSaveState] = useState<{ saving: boolean; error?: string }>({ saving: false })

  // The theme is a data attribute on <html>; index.css keys every palette off it.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Save errors are transient — clear them rather than leaving a stale banner.
  useEffect(() => {
    if (!saveState.error) return
    const timer = setTimeout(() => setSaveState(s => ({ ...s, error: undefined })), 6000)
    return () => clearTimeout(timer)
  }, [saveState.error])

  const refreshClips = useCallback(async () => {
    if (!window.flash) return
    const [clipList, storageInfo] = await Promise.all([
      window.flash.getClips(),
      window.flash.getStorage(),
    ])
    setClips(clipList)
    setStorage(storageInfo)
  }, [])

  // Build game list from actual clips
  const games = Array.from(
    clips.reduce((map, clip) => {
      map.set(clip.game, (map.get(clip.game) ?? 0) + 1)
      return map
    }, new Map<string, number>())
  ).map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  const allGames = clips.length > 0 ? [{ name: 'All', count: clips.length }, ...games] : []

  const gameFilteredClips = gameFilter === 'All' ? clips : clips.filter(c => c.game === gameFilter)
  const filteredClips = clipQuery ? gameFilteredClips.filter(clip => matchesQuery(clip, clipQuery)) : gameFilteredClips
  const selectedClips = useMemo(() => clips.filter(clip => selectedIds.has(clip.id)), [clips, selectedIds])

  const clearSelected = useCallback(() => {
    selectionAnchor.current = null
    setSelectedIds(clearSelection())
  }, [])

  const toggleSelected = useCallback((id: string) => {
    selectionAnchor.current = id
    setSelectedIds(selected => toggleSelection(selected, id))
  }, [])

  const selectDisplayedRange = useCallback((displayedIds: readonly string[], targetId: string) => {
    const previousAnchor = selectionAnchor.current
    const anchor = previousAnchor && displayedIds.includes(previousAnchor) ? previousAnchor : targetId
    if (anchor !== previousAnchor) selectionAnchor.current = anchor
    setSelectedIds(selected => selectRange(selected, displayedIds, anchor, targetId))
  }, [])

  const selectAllDisplayed = useCallback((displayedIds: readonly string[]) => {
    selectionAnchor.current = displayedIds[0] ?? null
    setSelectedIds(new Set(displayedIds))
  }, [])

  // A rename, delete or move changes IDs because IDs are paths. Drop only the
  // stale entries; filtering the grid does not discard a deliberate selection.
  useEffect(() => {
    const liveIds = new Set(clips.map(clip => clip.id))
    if (selectionAnchor.current && !liveIds.has(selectionAnchor.current)) selectionAnchor.current = null
    setSelectedIds(selected => {
      const next = new Set([...selected].filter(id => liveIds.has(id)))
      return next.size === selected.size ? selected : next
    })
  }, [clips])

  const updateSettings = useCallback(async (partial: Partial<Settings>) => {
    if (!window.flash) return
    const updated = await window.flash.setSettings(partial)
    setSettings(updated)
    if (partial.clipsFolder) refreshClips()
    // A rebind can fail if another program already owns the key.
    if (partial.hotkey) {
      const status = await window.flash.getHotkeyStatus()
      setHotkeysRegistered(status)
    }
    if (partial.voiceEnabled !== undefined || partial.voicePhrase !== undefined
      || partial.voiceRawFloor !== undefined || partial.voiceCooldownMs !== undefined) {
      setVoiceStatus(await window.flash.getVoiceStatus())
    }
  }, [refreshClips])

  // Confirmation lives here so ClipCard and ClipPlayer both get the same dialog
  // without either of them knowing it exists.
  const deleteClip = useCallback((clip: Clip) => {
    setConfirmRequest({
      title: `Delete this clip?`,
      body: `"${clip.title}" (${clip.game}, ${formatBytes(clip.size)}) will be permanently deleted from disk.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await window.flash?.deleteClip(clip.filePath)
        refreshClips()
      },
    })
  }, [refreshClips])

  const deleteSelection = useCallback(() => {
    const selection = [...selectedClips]
    const count = selection.length
    if (!count) return
    const itemWord = count === 1 ? 'item' : 'items'
    const size = selection.reduce((total, clip) => total + clip.size, 0)
    setConfirmRequest({
      title: `Delete ${count} selected ${itemWord}?`,
      body: `${count} selected ${itemWord} (${formatBytes(size)}) will be permanently deleted from disk.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await Promise.all(selection.map(clip => window.flash?.deleteClip(clip.filePath)))
        clearSelected()
        await refreshClips()
      },
    })
  }, [clearSelected, refreshClips, selectedClips])

  const renameClip = useCallback(async (clip: Clip, name: string) => {
    if (!window.flash) return 'Rename is unavailable'
    const result = await window.flash.renameClip(clip.filePath, name)
    if (result.error) return result.error
    await refreshClips()
    return null
  }, [refreshClips])

  const toggleRecording = useCallback(async () => {
    if (!window.flash) return
    if (isRecording) await window.flash.capture.stopReplayBuffer()
    else await window.flash.capture.startReplayBuffer()
  }, [isRecording])

  useEffect(() => {
    if (!window.flash) return

    window.flash.onRecordingState(setIsRecording)
    window.flash.onNavigate(setActive)
    window.flash.getRecordingState().then(setIsRecording)
    window.flash.getSettings().then(setSettings)
    window.flash.getVoiceStatus().then(setVoiceStatus)
    window.flash.getHotkeyStatus().then(setHotkeysRegistered)
    window.flash.capture.listDisplays().then(setDisplays)
    window.flash.capture.onSaveState(setSaveState)
    window.flash.onIdentifyGame(setIdentifyRequest)
    window.flash.getLearnedGames().then(setLearnedGames)
    window.flash.hasCaptureAddon().then(setCaptureAvailable)
    window.flash.capture.getStatus().then(s => { setEncoder(s.encoder); if (s.captureBackend) setCaptureBackend(s.captureBackend) })
    window.flash.onGameDetected(setDetectedGame)
    window.flash.getCurrentGame().then(setDetectedGame)
    window.flash.onClipSavedRefresh(() => refreshClips())

    // Served over flash-clip, not file://. A renderer page on
    // http://localhost:5173 cannot load file:// media, so in development the
    // sound silently never played - and the empty catch below hid it.
    window.flash.onPlayClipSound((soundPath: string) => {
      const audio = new Audio(clipUrl(soundPath))
      audio.volume = 0.7
      audio.play().catch(error => console.warn('Could not play the clip sound', error))
    })

    refreshClips()
  }, [refreshClips])

  return (
    <div className="flex flex-col" style={{ width: '100vw', height: '100vh', background: 'var(--bg)', overflow: 'hidden' }}>
      <TopBar
        active={active} setActive={setActive}
        isRecording={isRecording} onToggleRecording={toggleRecording}
        detectedGame={detectedGame} captureAvailable={captureAvailable}
        hotkey={settings.hotkey} saveState={saveState}
      />
      <div className="flex flex-1 overflow-hidden">
        {active !== 'Settings' && (
          <Sidebar
            games={allGames} gameFilter={gameFilter} setGameFilter={setGameFilter}
            storage={storage} onOpenFolder={() => window.flash?.openClipsFolder()}
          />
        )}
        <main className="relative flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
          {active === 'Settings' ? (
            <SettingsPanel
              settings={settings} onChange={updateSettings} storage={storage} encoder={encoder}
              captureBackend={captureBackend}
              voiceStatus={voiceStatus}
              hotkeysRegistered={hotkeysRegistered} displays={displays} health={health}
              learnedGames={learnedGames}
              onForgetGame={async exe => setLearnedGames(await window.flash!.forgetGame(exe))}
              onOpenFolder={() => window.flash?.openClipsFolder()}
              onPickFolder={async () => {
                const folder = await window.flash?.pickClipsFolder()
                if (folder) { setSettings(s => ({ ...s, clipsFolder: folder })); refreshClips() }
              }}
            />
          ) : (
            <ClipsPanel
              clips={filteredClips}
              query={clipQuery} onQueryChange={setClipQuery}
              shortcutsEnabled={previewIndex === null && editingClip === null}
              selectedIds={selectedIds}
              onToggleSelection={toggleSelected}
              onSelectRange={selectDisplayedRange}
              onSelectAll={selectAllDisplayed}
              onClearSelection={clearSelected}
              // Index into filteredClips, not into the panel's own sorted copy —
              // sorting by Longest/Largest used to open a different clip.
              onOpenClip={clip => setPreviewIndex(filteredClips.findIndex(c => c.id === clip.id))}
              onDeleteClip={deleteClip}
              onRenameClip={renameClip}
              isRecording={isRecording} captureAvailable={captureAvailable}
              hotkey={settings.hotkey} bufferLength={settings.bufferLength}
              suspendThumbnails={previewIndex !== null || editingClip !== null}
            />
          )}
          {active !== 'Settings' && selectedClips.length > 0 && (
            <SelectionBar
              items={selectedClips}
              games={games.map(game => game.name)}
              onClear={clearSelected}
              onDelete={deleteSelection}
              onRefresh={refreshClips}
            />
          )}
        </main>
      </div>
      {/* Unmounted while the editor is open, not just covered by it. Left
          mounted, its <video> keeps playing underneath — you hear a clip you
          cannot see — and its window keydown listener still steals the arrow
          keys from the editor's own scrubbing. */}
      {previewIndex !== null && !editingClip && filteredClips.length > 0 && (
        <ClipPlayer clips={filteredClips} startIndex={previewIndex} onClose={() => setPreviewIndex(null)} onDelete={deleteClip} onEdit={setEditingClip} onRename={renameClip} />
      )}
      {editingClip && (
        <Editor clip={editingClip} onClose={() => setEditingClip(null)} />
      )}
      {confirmRequest && (
        <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />
      )}
      {identifyRequest && (
        <IdentifyGamePrompt request={identifyRequest} onClose={name => {
          window.flash?.identifyGame(identifyRequest.exe, name)
          setIdentifyRequest(null)
        }} />
      )}
    </div>
  )
}
