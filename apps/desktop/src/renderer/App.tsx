import { useState, useEffect, useCallback } from 'react'

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

interface Settings {
  clipsFolder: string
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

// ── Clip Player Modal ─────────────────────────────────────────────────────────

function ClipPlayer({ clips, startIndex, onClose, onDelete }: {
  clips: Clip[]
  startIndex: number
  onClose: () => void
  onDelete: (clip: Clip) => void
}) {
  const [index, setIndex] = useState(startIndex)
  const clip = clips[index]

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
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'rgba(4,0,4,0.97)' }}>
      <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="flex items-center gap-1.5 text-sm transition-colors hover:text-white" style={{ color: '#666' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            Back
          </button>
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)' }} />
          <span style={{ fontSize: 13, color: '#888' }}>
            {index + 1} <span style={{ color: '#444' }}>/ {clips.length}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => window.flash?.showClipInFolder(clip.filePath)}
            className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5"
            style={{ color: '#666', border: '1px solid rgba(255,255,255,0.08)' }}>Show in Folder</button>
          <button onClick={() => { if (confirm(`Delete "${clip.title}"?`)) { onDelete(clip); onClose() } }}
            className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-red-500/10"
            style={{ color: '#a33', border: '1px solid rgba(232,25,44,0.2)' }}>Delete</button>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5" style={{ color: '#555' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <button onClick={goPrev} disabled={index === 0} className="flex items-center justify-center px-4 shrink-0"
          style={{ color: index === 0 ? '#333' : '#666', cursor: index === 0 ? 'default' : 'pointer' }}>
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
          <div className="w-full flex items-start justify-between" style={{ maxWidth: 900 }}>
            <div>
              <h2 style={{ fontWeight: 600, fontSize: 16, color: '#f0f0f0', marginBottom: 4 }}>{clip.title}</h2>
              <div className="flex items-center gap-3" style={{ color: '#555', fontSize: 12 }}>
                <span style={{ color: '#e8192c' }}>{clip.game}</span>
                <span>·</span>
                <span>{formatBytes(clip.size)}</span>
                <span>·</span>
                <span>{timeAgo(clip.createdAt)}</span>
              </div>
            </div>
            <span style={{ fontSize: 11, color: '#444' }}>← → Esc</span>
          </div>
        </div>

        <button onClick={goNext} disabled={index === clips.length - 1} className="flex items-center justify-center px-4 shrink-0"
          style={{ color: index === clips.length - 1 ? '#333' : '#666', cursor: index === clips.length - 1 ? 'default' : 'pointer' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
    </div>
  )
}

// ── TopBar ─────────────────────────────────────────────────────────────────────

function TopBar({ active, setActive, isRecording, onToggleRecording, detectedGame, captureAvailable }: {
  active: string
  setActive: (c: string) => void
  isRecording: boolean
  onToggleRecording: () => void
  detectedGame: string | null
  captureAvailable: boolean
}) {
  return (
    <header className="flex items-center shrink-0 px-4 titlebar-drag" style={{ height: 48, background: '#0c000c', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2 mr-6 titlebar-no-drag">
        <div style={{ color: '#e8192c' }}><StickmanIcon size={20} /></div>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#f0f0f0', letterSpacing: '-0.01em' }}>
          flash<span style={{ color: '#e8192c' }}>.</span>
        </span>
      </div>

      <nav className="flex items-stretch h-full titlebar-no-drag">
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActive(tab)}
            className="relative px-4 transition-colors duration-100"
            style={{ fontWeight: active === tab ? 500 : 400, fontSize: 13, color: active === tab ? '#f0f0f0' : '#555', borderBottom: `2px solid ${active === tab ? '#e8192c' : 'transparent'}` }}>
            {tab}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-3 titlebar-no-drag">
        {detectedGame && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#4ade80' }} />
            <span style={{ fontSize: 11, color: '#888' }}>{detectedGame}</span>
          </div>
        )}

        <button onClick={onToggleRecording} disabled={!captureAvailable}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all"
          title={captureAvailable ? (isRecording ? 'Stop replay buffer' : 'Start replay buffer') : 'Capture engine unavailable'}
          style={{
            background: isRecording ? 'rgba(232,25,44,0.1)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${isRecording ? 'rgba(232,25,44,0.2)' : 'rgba(255,255,255,0.06)'}`,
            cursor: captureAvailable ? 'pointer' : 'not-allowed',
            opacity: captureAvailable ? 1 : 0.5,
          }}>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: isRecording ? '#e8192c' : '#444', animation: isRecording ? 'pulse-red 1.4s ease-in-out infinite' : 'none' }} />
          <span style={{ fontSize: 11, color: isRecording ? '#e8192c' : '#666', fontWeight: 500 }}>
            {isRecording ? 'REC' : 'IDLE'}
          </span>
        </button>

        <kbd style={{ fontSize: 11, color: '#444', background: '#111', border: '1px solid #222', borderRadius: 4, padding: '2px 6px' }}>F8</kbd>
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
    <aside className="flex flex-col shrink-0 overflow-y-auto" style={{ width: 196, background: '#080008', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="p-3">
        <button onClick={onOpenFolder}
          className="w-full py-2 rounded-lg transition-all hover:brightness-110 active:scale-95 mb-4"
          style={{ fontWeight: 600, fontSize: 13, background: '#e8192c', color: 'white' }}>
          Open Clips Folder
        </button>

        <p style={{ fontSize: 10, fontWeight: 600, color: '#333', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 8 }}>Games</p>

        {games.length === 0 ? (
          <p style={{ fontSize: 11, color: '#333', padding: '8px 12px', lineHeight: 1.5 }}>
            No clips yet. Games appear here once you clip them.
          </p>
        ) : (
          games.map(g => (
            <button key={g.name} onClick={() => setGameFilter(g.name)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all duration-100 text-left mb-0.5"
              style={{ background: gameFilter === g.name ? 'rgba(232,25,44,0.1)' : 'transparent', color: gameFilter === g.name ? '#f0f0f0' : '#555' }}>
              <span style={{ fontSize: 13, fontWeight: gameFilter === g.name ? 500 : 400 }}>{g.name}</span>
              <span style={{ fontSize: 11, color: '#333' }}>{g.count}</span>
            </button>
          ))
        )}

        <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '12px 0' }} />

        <p style={{ fontSize: 10, fontWeight: 600, color: '#333', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 8 }}>Storage</p>
        <div className="px-3 pb-1">
          <div className="flex justify-between mb-1">
            <span style={{ fontSize: 11, color: '#666' }}>{formatBytes(storage.used)}</span>
            <span style={{ fontSize: 11, color: '#444' }}>{storage.clips} clip{storage.clips === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

// ── ClipCard ───────────────────────────────────────────────────────────────────

function ClipCard({ clip, onClick, onDelete }: { clip: Clip; onClick: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false)

  return (
    <div className="rounded-xl overflow-hidden cursor-pointer transition-all duration-150 relative"
      style={{ background: '#0e000e', border: `1px solid ${hov ? 'rgba(232,25,44,0.3)' : 'rgba(255,255,255,0.05)'}`, transform: hov ? 'translateY(-1px)' : 'none', boxShadow: hov ? '0 4px 20px rgba(0,0,0,0.5)' : 'none' }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onClick}>
      <div className="relative overflow-hidden" style={{ aspectRatio: '16/9', background: '#0a0008' }}>
        <video
          src={`file://${clip.filePath.replace(/\\/g, '/')}#t=0.5`}
          preload="metadata"
          muted
          className="w-full h-full object-cover"
          style={{ pointerEvents: 'none' }}
        />
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <span style={{ fontSize: 10, color: '#ccc' }}>{clip.duration}</span>
        </div>
        {hov && (
          <>
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.35)' }}>
              <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#e8192c', boxShadow: '0 0 20px rgba(232,25,44,0.5)' }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><polygon points="3,1 11,6.5 3,12" fill="white"/></svg>
              </div>
            </div>
            <button
              onClick={e => { e.stopPropagation(); if (confirm(`Delete "${clip.title}"?`)) onDelete() }}
              className="absolute top-2 right-2 w-6 h-6 rounded flex items-center justify-center transition-all hover:bg-red-500/20"
              style={{ background: 'rgba(0,0,0,0.6)', color: '#a55' }}>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </>
        )}
        <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 10, fontWeight: 500, color: '#888' }}>{clip.game}</span>
        </div>
      </div>
      <div className="p-3">
        <p style={{ fontSize: 12, fontWeight: 500, color: '#d0d0d0', marginBottom: 6, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clip.title}</p>
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 11, color: '#444' }}>{formatBytes(clip.size)}</span>
          <span style={{ fontSize: 10, color: '#2f2f2f' }}>{timeAgo(clip.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}

// ── ClipsPanel ─────────────────────────────────────────────────────────────────

function ClipsPanel({ clips, onOpenClip, onDeleteClip, isRecording, captureAvailable }: {
  clips: Clip[]
  onOpenClip: (index: number) => void
  onDeleteClip: (clip: Clip) => void
  isRecording: boolean
  captureAvailable: boolean
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
              style={{ fontWeight: sort === s ? 500 : 400, background: sort === s ? 'rgba(232,25,44,0.12)' : 'rgba(255,255,255,0.03)', color: sort === s ? '#f0f0f0' : '#555', border: `1px solid ${sort === s ? 'rgba(232,25,44,0.25)' : 'rgba(255,255,255,0.04)'}` }}>
              {s}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: '#333' }}>{clips.length} clip{clips.length === 1 ? '' : 's'}</span>
      </div>

      {clips.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3" style={{ minHeight: 300 }}>
          <div style={{ color: '#2a1a2a' }}><StickmanIcon size={48} /></div>
          <p style={{ fontSize: 15, fontWeight: 500, color: '#555' }}>No clips yet</p>
          <p style={{ fontSize: 13, color: '#3a3a3a', textAlign: 'center', maxWidth: 380, lineHeight: 1.6 }}>
            {!captureAvailable
              ? 'Capture engine unavailable. Check that the native addon is built.'
              : isRecording
                ? <>Replay buffer is running. Press <kbd style={{ background: '#1a0016', border: '1px solid rgba(232,25,44,0.3)', borderRadius: 4, padding: '1px 6px', color: '#e8192c', fontSize: 12 }}>F8</kbd> to save the last {30} seconds.</>
                : 'Click the IDLE badge in the top bar to start the replay buffer, then press F8 to clip.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {sorted.map((clip, i) => (
            <ClipCard key={clip.id} clip={clip} onClick={() => onOpenClip(i)} onDelete={() => onDeleteClip(clip)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Toggle ─────────────────────────────────────────────────────────────────────

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="relative w-8 h-4 rounded-full transition-all duration-150 shrink-0"
      style={{ background: on ? '#e8192c' : 'rgba(255,255,255,0.08)', border: `1px solid ${on ? '#e8192c' : 'rgba(255,255,255,0.1)'}` }}>
      <div className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all duration-150" style={{ left: on ? 'calc(100% - 14px)' : '1px' }} />
    </button>
  )
}

// ── SettingsPanel ──────────────────────────────────────────────────────────────

function SettingsPanel({ settings, onChange, storage, encoder, onOpenFolder, onPickFolder }: {
  settings: Settings
  onChange: (partial: Partial<Settings>) => void
  storage: { used: number; clips: number }
  encoder: string
  onOpenFolder: () => void
  onPickFolder: () => void
}) {
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between py-3 gap-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: 13, color: '#888' }}>{label}</span>
      {children}
    </div>
  )

  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded-xl p-5" style={{ background: '#0e000e', border: '1px solid rgba(255,255,255,0.05)' }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: '#e8192c', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{title}</p>
      {children}
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 style={{ fontWeight: 600, fontSize: 18, color: '#f0f0f0', marginBottom: 2 }}>Settings</h1>
      <p style={{ fontSize: 13, color: '#444', marginBottom: 24 }}>Configure your Flash recording preferences</p>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
        <Card title="Capture">
          <Row label="Hotkey">
            <kbd style={{ fontSize: 11, color: '#e8192c', background: 'rgba(232,25,44,0.1)', border: '1px solid rgba(232,25,44,0.25)', borderRadius: 4, padding: '2px 8px' }}>F8</kbd>
          </Row>
          <Row label="Quality">
            <select value={settings.quality} onChange={e => onChange({ quality: e.target.value })}
              style={{ fontSize: 12, color: '#ccc', background: '#1a001a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '4px 8px' }}>
              {QUALITY_OPTIONS.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </Row>
          <Row label={`Buffer length — ${settings.bufferLength}s`}>
            <input type="range" min={10} max={300} step={5} value={settings.bufferLength}
              onChange={e => onChange({ bufferLength: +e.target.value })}
              style={{ accentColor: '#e8192c', width: 120 }} />
          </Row>
          <Row label="Audio capture">
            <Toggle on={settings.audioCapture} onChange={() => onChange({ audioCapture: !settings.audioCapture })} />
          </Row>
          <Row label="Encoder">
            <span style={{ fontSize: 12, color: encoder === 'none' ? '#a33' : '#4ade80' }}>{encoder}</span>
          </Row>
        </Card>

        <Card title="Notifications">
          <Row label="Clip saved notification">
            <Toggle on={settings.notifications} onChange={() => onChange({ notifications: !settings.notifications })} />
          </Row>
          <p style={{ fontSize: 11, color: '#3a3a3a', paddingTop: 12, lineHeight: 1.5 }}>
            Shows a popup in the top-left corner and plays a sound when a clip is saved.
          </p>
        </Card>

        <Card title="Storage">
          <div className="mb-4 pt-2">
            <div className="flex justify-between mb-1">
              <span style={{ fontSize: 12, color: '#666' }}>{formatBytes(storage.used)} used</span>
              <span style={{ fontSize: 11, color: '#444' }}>{storage.clips} clip{storage.clips === 1 ? '' : 's'}</span>
            </div>
          </div>
          <Row label="Clips folder">
            <button onClick={onPickFolder}
              className="px-2 py-1 rounded transition-all hover:bg-white/5"
              style={{ fontSize: 11, color: '#666', border: '1px solid rgba(255,255,255,0.08)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={settings.clipsFolder}>
              {settings.clipsFolder}
            </button>
          </Row>
          <Row label="Auto-delete clips after">
            <select value={settings.autoDeleteDays} onChange={e => onChange({ autoDeleteDays: +e.target.value })}
              style={{ fontSize: 12, color: '#ccc', background: '#1a001a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '4px 8px' }}>
              <option value={0}>Never</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </Row>
          <Row label="Format"><span style={{ fontSize: 12, color: '#666' }}>MP4 / H.264</span></Row>
          <button onClick={onOpenFolder}
            className="mt-4 w-full py-2 rounded-lg text-xs transition-all hover:brightness-110"
            style={{ fontWeight: 600, background: '#e8192c', color: 'white' }}>
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
    clipsFolder: '', quality: '1080p 60fps', bufferLength: 30,
    audioCapture: true, autoSave: true, notifications: true, autoDeleteDays: 0,
  })
  const [encoder, setEncoder] = useState('none')
  const [captureAvailable, setCaptureAvailable] = useState(false)

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
  }, [refreshClips])

  const deleteClip = useCallback(async (clip: Clip) => {
    if (!window.flash) return
    await window.flash.deleteClip(clip.filePath)
    refreshClips()
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
    <div className="flex flex-col" style={{ width: '100vw', height: '100vh', background: '#060006', overflow: 'hidden' }}>
      <TopBar
        active={active} setActive={setActive}
        isRecording={isRecording} onToggleRecording={toggleRecording}
        detectedGame={detectedGame} captureAvailable={captureAvailable}
      />
      <div className="flex flex-1 overflow-hidden">
        {active !== 'Settings' && (
          <Sidebar
            games={allGames} gameFilter={gameFilter} setGameFilter={setGameFilter}
            storage={storage} onOpenFolder={() => window.flash?.openClipsFolder()}
          />
        )}
        <main className="flex-1 flex flex-col overflow-hidden" style={{ background: '#080008' }}>
          {active === 'Settings' ? (
            <SettingsPanel
              settings={settings} onChange={updateSettings} storage={storage} encoder={encoder}
              onOpenFolder={() => window.flash?.openClipsFolder()}
              onPickFolder={async () => {
                const folder = await window.flash?.pickClipsFolder()
                if (folder) { setSettings(s => ({ ...s, clipsFolder: folder })); refreshClips() }
              }}
            />
          ) : (
            <ClipsPanel
              clips={filteredClips} onOpenClip={setPreviewIndex} onDeleteClip={deleteClip}
              isRecording={isRecording} captureAvailable={captureAvailable}
            />
          )}
        </main>
      </div>
      {previewIndex !== null && filteredClips.length > 0 && (
        <ClipPlayer clips={filteredClips} startIndex={previewIndex} onClose={() => setPreviewIndex(null)} onDelete={deleteClip} />
      )}
    </div>
  )
}
