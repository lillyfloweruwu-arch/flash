import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

// Pieces shared by the feed, the library and settings: formatting helpers, the
// one icon family, and the small controls every screen draws the same way.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Clip {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

export function timeAgo(timestamp: number): string {
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

// ── Icons ─────────────────────────────────────────────────────────────────────

// One outlined family, 24-unit grid, 1.6 stroke. A glyph that is "on" fills
// rather than switching to a second drawing, so state reads at a glance.
type IconName =
  | 'star' | 'copy' | 'folder' | 'trash' | 'edit' | 'camera' | 'send' | 'play' | 'pause'
  | 'volume' | 'mute' | 'up' | 'down' | 'left' | 'close' | 'search' | 'grid' | 'pencil' | 'check'
  | 'image'

const PATHS: Record<IconName, React.ReactNode> = {
  star: <path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 00-1.5-1.5H6A1.5 1.5 0 004.5 6v8A1.5 1.5 0 006 15.5h2.5" /></>,
  folder: <path d="M3.5 7.5A1.5 1.5 0 015 6h4.3l2 2.2H19a1.5 1.5 0 011.5 1.5v8.3A1.5 1.5 0 0119 19.5H5A1.5 1.5 0 013.5 18z" />,
  trash: <><path d="M4.5 7h15M9.5 7V5a1 1 0 011-1h3a1 1 0 011 1v2" /><path d="M6.5 7l.8 11.6A1.5 1.5 0 008.8 20h6.4a1.5 1.5 0 001.5-1.4L17.5 7" /><path d="M10 11v5.5M14 11v5.5" /></>,
  edit: <><circle cx="6.5" cy="6.5" r="2.6" /><circle cx="6.5" cy="17.5" r="2.6" /><path d="M8.6 8.1L20 18M8.6 15.9L20 6" /></>,
  camera: <><path d="M4 8.5A1.5 1.5 0 015.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5z" /><circle cx="12" cy="12.8" r="3.4" /></>,
  send: <><path d="M20.5 3.5L10.2 13.8" /><path d="M20.5 3.5l-6.6 17-3.7-6.7-6.7-3.7z" /></>,
  play: <path d="M7 4.8v14.4a.8.8 0 001.2.7l11.6-7.2a.8.8 0 000-1.4L8.2 4.1A.8.8 0 007 4.8z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>,
  volume: <><path d="M11 5L6.5 9H3.5v6h3L11 19z" /><path d="M15 9a4.2 4.2 0 010 6M17.8 6.2a8.2 8.2 0 010 11.6" /></>,
  mute: <><path d="M11 5L6.5 9H3.5v6h3L11 19z" /><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" /></>,
  up: <path d="M6 14.5l6-6 6 6" />,
  down: <path d="M6 9.5l6 6 6-6" />,
  left: <path d="M14.5 6l-6 6 6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M15.5 15.5L20 20" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
  pencil: <path d="M4.5 19.5l1-4.2L15.8 5a1.8 1.8 0 012.5 0l.7.7a1.8 1.8 0 010 2.5L8.7 18.5z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="15.5" cy="9.5" r="1.6" /><path d="M4 17l5-5 4 4 2.5-2.5L20 18" /></>,
}

export function Icon({ name, size = 20, filled = false, strokeWidth = 1.6 }: {
  name: IconName
  size?: number
  filled?: boolean
  strokeWidth?: number
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name]}
    </svg>
  )
}

export function StickmanIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

// The game's initial in a ring: the feed's author mark. There is no game art
// to show, and a monogram is honest about that.
export function GameMark({ game, size = 36 }: { game: string; size?: number }) {
  return (
    <span aria-hidden="true" className="display flex items-center justify-center shrink-0"
      style={{
        width: size, height: size, borderRadius: 999, fontSize: size * 0.5,
        color: 'var(--fg)', border: '1px solid var(--line)', background: 'rgba(0,0,0,0.35)',
      }}>
      {game.trim().charAt(0) || '?'}
    </span>
  )
}

// ── Controls ──────────────────────────────────────────────────────────────────

export function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onChange}
      className="relative shrink-0 rounded-full transition-colors duration-150"
      style={{
        width: 36, height: 20,
        background: on ? 'var(--accent)' : 'transparent',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
      }}>
      <span className="absolute rounded-full transition-all duration-150"
        style={{
          top: 3, width: 12, height: 12, left: on ? 19 : 3,
          background: on ? 'var(--on-accent)' : 'var(--muted)',
        }} />
    </button>
  )
}

// `display` is what the screen shows; `title` is what the rename box starts
// from and what the file is actually called. They differ only for clips
// nobody has renamed, where the filename is a timestamp and the title made
// from it is six numbers in a row.
export function RenameTitle({ title, display, onCommit, className, style }: {
  title: string
  display?: string
  onCommit: (name: string) => Promise<string | null>
  className?: string
  style?: React.CSSProperties
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
        className={`group flex items-end gap-3 min-w-0 text-left ${className ?? ''}`} style={{ maxWidth: '100%', ...style }}>
        <span className="truncate" style={{ paddingBottom: '0.04em' }}>{display ?? title}</span>
        <span className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity shrink-0"
          style={{ color: 'var(--muted)', marginBottom: '0.18em', fontFamily: 'var(--font-ui)' }}>
          <Icon name="pencil" size={16} />
        </span>
      </button>
    )
  }

  return (
    <div draggable={false} onClick={event => event.stopPropagation()} style={{ width: '100%', maxWidth: 520 }}>
      <div className="flex items-center gap-2">
        <input autoFocus value={value} disabled={busy} aria-label="Clip name"
          onChange={event => setValue(event.target.value)}
          onFocus={event => event.currentTarget.select()}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter') { event.preventDefault(); commit() }
            if (event.key === 'Escape') { event.preventDefault(); setEditing(false); setError(null) }
          }}
          className="field flex-1 min-w-0" style={{ fontSize: 14, background: 'rgba(0,0,0,0.5)' }} />
        <button type="button" disabled={busy} onClick={commit} className="btn btn-solid">
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(null) }} className="btn">
          Cancel
        </button>
      </div>
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--alert)', marginTop: 6 }}>{error}</p>}
    </div>
  )
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

function DialogFrame({ label, onBackdrop, width = 400, children }: {
  label: string
  onBackdrop?: () => void
  width?: number
  children: React.ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current!
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
    focusable()[0]?.focus()
    const contain = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusable()[0]?.focus()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      event.preventDefault()
      const controls = focusable()
      const index = controls.indexOf(document.activeElement as HTMLElement)
      controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus()
    }
    document.addEventListener('focusin', contain)
    dialog.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('focusin', contain)
      dialog.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(4,4,6,0.72)', animation: 'overlay-in 0.12s ease-out' }}
      onClick={onBackdrop}>
      <div ref={dialogRef} onKeyDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={label}
        onClick={e => e.stopPropagation()}
        style={{
          width, padding: 28, background: 'var(--panel)', borderRadius: 10,
          border: '1px solid var(--edge)', boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          animation: 'dialog-in 0.16s var(--ease-out)',
        }}>
        {children}
      </div>
    </div>
  )
}

export interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const accepted = useRef(false)
  const accept = useCallback(() => {
    if (accepted.current) return
    accepted.current = true
    request.onConfirm()
    onClose()
  }, [request, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    // Capture phase: the feed also listens for Escape and would leave
    // underneath the dialog otherwise.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [accept, onClose])

  return (
    <DialogFrame label={request.title} onBackdrop={onClose}>
      <h2 className="display" style={{ fontSize: 30, color: 'var(--fg)', marginBottom: request.body ? 12 : 24 }}>
        {request.title}
      </h2>
      {request.body && (
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 24 }}>{request.body}</p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn">Cancel</button>
        <button onClick={accept} className={`btn btn-solid ${request.destructive ? 'btn-danger' : ''}`}>
          {request.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </DialogFrame>
  )
}

// Shown when something is running that looks like a game but is not in the
// bundled database. Naming it once teaches Flash permanently; dismissing it
// records the executable as "not a game" so it stops asking.
export function IdentifyGamePrompt({ request, onClose }: {
  request: { exe: string; suggested: string }
  onClose: (name: string | null) => void
}) {
  const [name, setName] = useState(request.suggested)

  return (
    <DialogFrame label="Is this a game?" width={440}>
      <h2 className="display" style={{ fontSize: 30, color: 'var(--fg)', marginBottom: 12 }}>Is this a game?</h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 18 }}>
        Flash does not recognise <span style={{ color: 'var(--fg)' }}>{request.exe}</span>. Name it and
        your clips will be filed under it from now on.
      </p>
      <input value={name} onChange={e => setName(e.target.value)} autoFocus aria-label="Game name"
        onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onClose(name.trim()); if (e.key === 'Escape') onClose(null) }}
        className="field w-full mb-6" style={{ fontSize: 14 }} />
      <div className="flex justify-end gap-2">
        <button onClick={() => onClose(null)} className="btn">Not a game</button>
        <button onClick={() => name.trim() && onClose(name.trim())} disabled={!name.trim()} className="btn btn-solid">
          Save
        </button>
      </div>
    </DialogFrame>
  )
}
