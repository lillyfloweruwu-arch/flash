import { useState, useEffect, useCallback, useRef } from 'react'
import { THEMES, DEFAULT_THEME } from '../shared/themes'
import { toAccelerator } from '../shared/accelerator'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Clip {
  id: string
  title: string
  game: string
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
}

interface Settings {
  clipsFolder: string
  theme: string
  hotkey: string
  hotkeyShort: string
  shortClipSeconds: number
  displayId: number
  overlay: boolean
  overlayPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  quality: string
  bufferLength: number
  audioCapture: boolean
  autoSave: boolean
  notifications: boolean
  autoDeleteDays: number
}

const TABS = ['My Clips', 'Settings']

const QUALITY_OPTIONS = ['720p 30fps', '720p 60fps', '1080p 30fps', '1080p 60fps', '1440p 60fps', '4K 30fps']

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

function ClipPlayer({ clips, startIndex, onClose, onDelete }: {
  clips: Clip[]
  startIndex: number
  onClose: () => void
  onDelete: (clip: Clip) => void
}) {
  const [index, setIndex] = useState(startIndex)
  const [copied, setCopied] = useState<string | null>(null)
  const [trimming, setTrimming] = useState(false)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(10)
  const [trimBusy, setTrimBusy] = useState(false)
  const [trimNote, setTrimNote] = useState<string | null>(null)
  const clip = clips[index]

  // Reset the trim panel when moving between clips so bounds from the previous
  // clip cannot be applied to this one.
  useEffect(() => {
    setTrimming(false); setTrimNote(null); setTrimStart(0)
    setTrimEnd(Math.max(1, clips[index]?.durationSec ?? 10))
  }, [index, clips])

  const goNext = useCallback(() => setIndex(i => Math.min(i + 1, clips.length - 1)), [clips.length])
  const goPrev = useCallback(() => setIndex(i => Math.max(i - 1, 0)), [])

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
      <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--edge-soft)' }}>
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="flex items-center gap-1.5 text-sm transition-colors hover:text-white" style={{ color: 'var(--muted-2)' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            Back
          </button>
          <div style={{ width: 1, height: 14, background: 'var(--edge-soft)' }} />
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {index + 1} <span style={{ color: 'var(--muted-3)' }}>/ {clips.length}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            draggable
            onDragStart={e => { e.preventDefault(); window.flash?.startClipDrag(clip.filePath) }}
            onClick={async () => {
              const ok = await window.flash?.copyClipFile(clip.filePath)
              setCopied(ok ? 'Copied' : 'Copy failed')
              setTimeout(() => setCopied(null), 1600)
            }}
            title="Click to copy the file, or drag this straight into Discord"
            className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5"
            style={{ color: copied ? 'var(--accent)' : 'var(--muted-2)', border: `1px solid ${copied ? 'var(--accent-line)' : 'var(--edge-soft)'}`, cursor: 'grab' }}>
            {copied ?? 'Copy / Drag'}
          </button>
          <button onClick={() => window.flash?.showClipInFolder(clip.filePath)}
            className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5"
            style={{ color: 'var(--muted-2)', border: '1px solid var(--edge-soft)' }}>Show in Folder</button>
          <button onClick={() => { onDelete(clip); onClose() }}
            className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-red-500/10"
            style={{ color: 'var(--alert)', border: '1px solid var(--accent-line)' }}>Delete</button>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5" style={{ color: 'var(--muted-2)' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <button onClick={goPrev} disabled={index === 0} className="flex items-center justify-center px-4 shrink-0"
          style={{ color: index === 0 ? 'var(--faint)' : 'var(--muted-2)', cursor: index === 0 ? 'default' : 'pointer' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M13 4L7 10l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>

        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-4">
          <video
            key={clip.filePath}
            src={`file://${clip.filePath.replace(/\\/g, '/')}`}
            controls
            autoPlay
            className="rounded-xl"
            style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 220px)', background: '#000' }}
          />
          {/* Trim is a remux, not a re-encode — it returns in well under a second.
              The cut snaps back to the nearest keyframe (2s GOP), so the result
              reports where it actually started rather than pretending otherwise. */}
          <div className="w-full flex items-center gap-3" style={{ maxWidth: 900 }}>
            <button onClick={() => setTrimming(t => !t)}
              className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5 shrink-0"
              style={{ color: trimming ? 'var(--accent)' : 'var(--muted-2)', border: `1px solid ${trimming ? 'var(--accent-line)' : 'var(--edge-soft)'}` }}>
              Trim
            </button>
            {trimming && (
              <>
                <label style={{ fontSize: 11, color: 'var(--muted-2)' }}>Start</label>
                <input type="number" min={0} step={0.5} value={trimStart}
                  onChange={e => setTrimStart(Math.max(0, +e.target.value))}
                  style={{ width: 70, fontSize: 12, color: 'var(--fg)', background: 'var(--field)', border: '1px solid var(--edge)', borderRadius: 6, padding: '3px 6px' }} />
                <label style={{ fontSize: 11, color: 'var(--muted-2)' }}>End</label>
                <input type="number" min={0} step={0.5} value={trimEnd}
                  onChange={e => setTrimEnd(Math.max(0, +e.target.value))}
                  style={{ width: 70, fontSize: 12, color: 'var(--fg)', background: 'var(--field)', border: '1px solid var(--edge)', borderRadius: 6, padding: '3px 6px' }} />
                <button disabled={trimBusy || !(trimEnd > trimStart)}
                  onClick={async () => {
                    setTrimBusy(true); setTrimNote(null)
                    const r = await window.flash?.trimClip(clip.filePath, trimStart, trimEnd)
                    setTrimBusy(false)
                    if (!r || r.error) { setTrimNote(r?.error ?? 'Trim failed'); return }
                    const snapped = r.actualStartSeconds !== undefined && Math.abs(r.actualStartSeconds - trimStart) > 0.2
                    setTrimNote(snapped
                      ? `Saved ${r.duration}s — started at ${r.actualStartSeconds!.toFixed(1)}s (nearest keyframe)`
                      : `Saved ${r.duration}s`)
                  }}
                  className="px-3 py-1.5 rounded-md text-xs transition-all hover:brightness-110"
                  style={{ fontWeight: 600, color: 'var(--on-accent)', background: 'var(--accent)', opacity: trimBusy || !(trimEnd > trimStart) ? 0.5 : 1 }}>
                  {trimBusy ? 'Trimming…' : 'Save trim'}
                </button>
                {trimNote && <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>{trimNote}</span>}
              </>
            )}
          </div>

          <div className="w-full flex items-start justify-between" style={{ maxWidth: 900 }}>
            <div>
              <h2 style={{ fontWeight: 600, fontSize: 16, color: 'var(--fg)', marginBottom: 4 }}>{clip.title}</h2>
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

        <button onClick={goNext} disabled={index === clips.length - 1} className="flex items-center justify-center px-4 shrink-0"
          style={{ color: index === clips.length - 1 ? 'var(--faint)' : 'var(--muted-2)', cursor: index === clips.length - 1 ? 'default' : 'pointer' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
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

function ClipCard({ clip, onClick, onDelete }: { clip: Clip; onClick: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false)
  const [visible, setVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // Each thumbnail is a real <video> decoding a frame off disk. Mounting one per
  // clip means a library of 200 spins up 200 decoders at once, so hold the src
  // back until the card is actually near the viewport.
  useEffect(() => {
    const node = cardRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect() } },
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
      style={{ background: 'var(--panel)', border: `1px solid ${hov ? 'var(--accent-line)' : 'var(--edge-soft)'}`, transform: hov ? 'translateY(-1px)' : 'none', boxShadow: hov ? '0 4px 20px rgba(0,0,0,0.5)' : 'none' }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onClick}>
      <div className="relative overflow-hidden" style={{ aspectRatio: '16/9', background: 'var(--bg)' }}>
        {visible && (
          <video
            src={`file://${clip.filePath.replace(/\\/g, '/')}#t=0.5`}
            preload="metadata"
            muted
            className="w-full h-full object-cover"
            style={{ pointerEvents: 'none' }}
          />
        )}
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{clip.duration}</span>
        </div>
        {hov && (
          <>
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.35)' }}>
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
        <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', marginBottom: 6, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clip.title}</p>
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>{formatBytes(clip.size)}</span>
          <span style={{ fontSize: 10, color: 'var(--faint)' }}>{timeAgo(clip.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}

// ── ClipsPanel ─────────────────────────────────────────────────────────────────

function ClipsPanel({ clips, onOpenClip, onDeleteClip, isRecording, captureAvailable, hotkey, bufferLength }: {
  clips: Clip[]
  onOpenClip: (clip: Clip) => void
  onDeleteClip: (clip: Clip) => void
  isRecording: boolean
  captureAvailable: boolean
  hotkey: string
  bufferLength: number
}) {
  const [sort, setSort] = useState<'Recent' | 'Longest' | 'Largest'>('Recent')

  const sorted = [...clips].sort((a, b) => {
    if (sort === 'Longest') return b.durationSec - a.durationSec
    if (sort === 'Largest') return b.size - a.size
    return b.createdAt - a.createdAt
  })

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
        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{clips.length} clip{clips.length === 1 ? '' : 's'}</span>
      </div>

      {clips.length === 0 ? (
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
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {sorted.map(clip => (
            <ClipCard key={clip.id} clip={clip} onClick={() => onOpenClip(clip)} onDelete={() => onDeleteClip(clip)} />
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

function SettingsPanel({ settings, onChange, storage, encoder, hotkeyRegistered, displays, health, onOpenFolder, onPickFolder }: {
  settings: Settings
  onChange: (partial: Partial<Settings>) => void
  storage: { used: number; clips: number }
  encoder: string
  hotkeyRegistered: boolean
  displays: Display[]
  health: CaptureHealth | null
  onOpenFolder: () => void
  onPickFolder: () => void
}) {
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between py-3 gap-4" style={{ borderBottom: '1px solid var(--edge-soft)' }}>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
      {children}
    </div>
  )

  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded-xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--edge-soft)' }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{title}</p>
      {children}
    </div>
  )

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
            <HotkeyInput value={settings.hotkey} registered={hotkeyRegistered}
              onChange={hotkey => onChange({ hotkey })} />
          </Row>
          <Row label={`Short clip hotkey — last ${settings.shortClipSeconds}s`}>
            <HotkeyInput value={settings.hotkeyShort} registered
              onChange={hotkeyShort => onChange({ hotkeyShort })} />
          </Row>
          <Row label="Short clip length">
            <input type="range" min={5} max={60} step={5} value={settings.shortClipSeconds}
              onChange={e => onChange({ shortClipSeconds: +e.target.value })}
              style={{ accentColor: 'var(--accent)', width: 120 }} />
          </Row>
          {displays.length > 1 && (
            <Row label="Capture display">
              <select value={settings.displayId} onChange={e => onChange({ displayId: +e.target.value })}
                style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--field)', border: '1px solid var(--edge)', borderRadius: 6, padding: '4px 8px' }}>
                {displays.map(d => (
                  <option key={d.id} value={d.id}>
                    {`Display ${d.id + 1} — ${d.width}x${d.height}${d.isPrimary ? ' (primary)' : ''}`}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <Row label="Quality">
            <select value={settings.quality} onChange={e => onChange({ quality: e.target.value })}
              style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--field)', border: '1px solid var(--edge-soft)', borderRadius: 6, padding: '4px 8px' }}>
              {QUALITY_OPTIONS.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
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

        <Card title="Notifications">
          <Row label="Clip saved notification">
            <Toggle on={settings.notifications} onChange={() => onChange({ notifications: !settings.notifications })} />
          </Row>
          <Row label="In-game overlay">
            <Toggle on={settings.overlay} onChange={() => onChange({ overlay: !settings.overlay })} />
          </Row>
          {settings.overlay && (
            <Row label="Overlay corner">
              <select value={settings.overlayPosition} onChange={e => onChange({ overlayPosition: e.target.value as Settings['overlayPosition'] })}
                style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--field)', border: '1px solid var(--edge)', borderRadius: 6, padding: '4px 8px' }}>
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-right">Bottom right</option>
              </select>
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
            <select value={settings.autoDeleteDays} onChange={e => onChange({ autoDeleteDays: +e.target.value })}
              style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--field)', border: '1px solid var(--edge-soft)', borderRadius: 6, padding: '4px 8px' }}>
              <option value={0}>Never</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
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
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [detectedGame, setDetectedGame] = useState<string | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  const [storage, setStorage] = useState({ used: 0, clips: 0 })
  const [settings, setSettings] = useState<Settings>({
    clipsFolder: '', theme: DEFAULT_THEME, hotkey: 'F8', hotkeyShort: 'Shift+F8',
    shortClipSeconds: 15, displayId: 0, overlay: true, overlayPosition: 'top-left',
    quality: '1080p 60fps', bufferLength: 30,
    audioCapture: true, autoSave: true, notifications: true, autoDeleteDays: 0,
  })
  const [encoder, setEncoder] = useState('none')
  const [captureAvailable, setCaptureAvailable] = useState(false)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [hotkeyRegistered, setHotkeyRegistered] = useState(true)
  const [identifyRequest, setIdentifyRequest] = useState<{ exe: string; suggested: string } | null>(null)
  const [health, setHealth] = useState<CaptureHealth | null>(null)

  // Poll only while Settings is open — a background timer for a panel nobody is
  // looking at is exactly the kind of idle cost this app exists to avoid.
  useEffect(() => {
    if (active !== 'Settings' || !window.flash) return
    let cancelled = false
    const read = async () => {
      const s: any = await window.flash!.capture.getStatus()
      if (cancelled) return
      setHealth({
        healthy: s.captureHealthy !== false && s.recording !== false,
        fps: s.lastIntervalMs > 0 ? 1000 / s.lastIntervalMs : 0,
        buffered: s.bufferSeconds ?? 0,
        audioMode: s.audioMode,
        error: s.captureError,
      })
      if (s.encoder) setEncoder(s.encoder)
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

  const filteredClips = gameFilter === 'All' ? clips : clips.filter(c => c.game === gameFilter)

  const updateSettings = useCallback(async (partial: Partial<Settings>) => {
    if (!window.flash) return
    const updated = await window.flash.setSettings(partial)
    setSettings(updated)
    if (partial.clipsFolder) refreshClips()
    // A rebind can fail if another program already owns the key.
    if (partial.hotkey) {
      const status = await window.flash.getHotkeyStatus()
      setHotkeyRegistered(status.registered)
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
    window.flash.getHotkeyStatus().then(s => setHotkeyRegistered(s.registered))
    window.flash.capture.listDisplays().then(setDisplays)
    window.flash.capture.onSaveState(setSaveState)
    window.flash.onIdentifyGame(setIdentifyRequest)
    window.flash.hasCaptureAddon().then(setCaptureAvailable)
    window.flash.capture.getStatus().then(s => setEncoder(s.encoder))
    window.flash.onGameDetected(setDetectedGame)
    window.flash.getCurrentGame().then(setDetectedGame)
    window.flash.onClipSavedRefresh(() => refreshClips())

    window.flash.onPlayClipSound((soundPath: string) => {
      const audio = new Audio(`file://${soundPath.replace(/\\/g, '/')}`)
      audio.volume = 0.7
      audio.play().catch(() => {})
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
        <main className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
          {active === 'Settings' ? (
            <SettingsPanel
              settings={settings} onChange={updateSettings} storage={storage} encoder={encoder}
              hotkeyRegistered={hotkeyRegistered} displays={displays} health={health}
              onOpenFolder={() => window.flash?.openClipsFolder()}
              onPickFolder={async () => {
                const folder = await window.flash?.pickClipsFolder()
                if (folder) { setSettings(s => ({ ...s, clipsFolder: folder })); refreshClips() }
              }}
            />
          ) : (
            <ClipsPanel
              clips={filteredClips}
              // Index into filteredClips, not into the panel's own sorted copy —
              // sorting by Longest/Largest used to open a different clip.
              onOpenClip={clip => setPreviewIndex(filteredClips.findIndex(c => c.id === clip.id))}
              onDeleteClip={deleteClip}
              isRecording={isRecording} captureAvailable={captureAvailable}
              hotkey={settings.hotkey} bufferLength={settings.bufferLength}
            />
          )}
        </main>
      </div>
      {previewIndex !== null && filteredClips.length > 0 && (
        <ClipPlayer clips={filteredClips} startIndex={previewIndex} onClose={() => setPreviewIndex(null)} onDelete={deleteClip} />
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
