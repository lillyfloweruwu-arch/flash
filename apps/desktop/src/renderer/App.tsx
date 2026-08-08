import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Clip {
  id: number
  title: string
  game: string
  duration: string
  durationSec: number
  views: string
  likes: string
  time: string
  thumb: string
  filePath?: string
}

// ── Mock Data (replaced by SQLite later) ──────────────────────────────────────

const CATEGORIES = ['Home', 'My Clips', 'Highlights', 'Following', 'Trending', 'Settings']

const CLIPS: Clip[] = [
  { id: 1, title: 'Insane 1v5 Clutch', game: 'Valorant', duration: '0:34', durationSec: 34, views: '142K', likes: '8.2K', time: '2h ago', thumb: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=960&h=540&fit=crop&auto=format' },
  { id: 2, title: 'No-scope across the map', game: 'CS2', duration: '0:12', durationSec: 12, views: '89K', likes: '5.4K', time: '4h ago', thumb: 'https://images.unsplash.com/photo-1493711662062-fa541adb3fc8?w=960&h=540&fit=crop&auto=format' },
  { id: 3, title: 'Full Squad Wipe Solo', game: 'Apex Legends', duration: '1:02', durationSec: 62, views: '203K', likes: '14.1K', time: '6h ago', thumb: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=960&h=540&fit=crop&auto=format' },
  { id: 4, title: 'Widow Quad Kill', game: 'Overwatch 2', duration: '0:22', durationSec: 22, views: '31K', likes: '2.1K', time: '10h ago', thumb: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=960&h=540&fit=crop&auto=format' },
  { id: 5, title: 'Build Battle Win', game: 'Fortnite', duration: '0:48', durationSec: 48, views: '77K', likes: '4.9K', time: '1d ago', thumb: 'https://images.unsplash.com/photo-1560253023-3ec5d502959f?w=960&h=540&fit=crop&auto=format' },
  { id: 6, title: 'Helicopter Last Circle', game: 'Warzone', duration: '0:31', durationSec: 31, views: '55K', likes: '3.3K', time: '1d ago', thumb: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=960&h=540&fit=crop&auto=format' },
  { id: 7, title: '360 noscope off ramp', game: 'CS2', duration: '0:08', durationSec: 8, views: '420K', likes: '31K', time: '2d ago', thumb: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=960&h=540&fit=crop&auto=format' },
  { id: 8, title: 'Ranked Ace Round 15', game: 'Valorant', duration: '0:44', durationSec: 44, views: '18K', likes: '1.1K', time: '3d ago', thumb: 'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?w=960&h=540&fit=crop&auto=format' },
]

const GAMES = [
  { name: 'All Games', clips: 1053 },
  { name: 'Valorant', clips: 312 },
  { name: 'CS2', clips: 204 },
  { name: 'Apex Legends', clips: 189 },
  { name: 'Overwatch 2', clips: 97 },
  { name: 'Fortnite', clips: 143 },
  { name: 'Warzone', clips: 108 },
]

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

// ── Clip Preview Modal ────────────────────────────────────────────────────────

function ClipPreview({ clips, startIndex, onClose }: { clips: Clip[]; startIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(startIndex)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [liked, setLiked] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clip = clips[index]

  const goNext = useCallback(() => {
    setIndex(i => Math.min(i + 1, clips.length - 1))
    setProgress(0)
    setPlaying(false)
  }, [clips.length])

  const goPrev = useCallback(() => {
    setIndex(i => Math.max(i - 1, 0))
    setProgress(0)
    setPlaying(false)
  }, [])

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setProgress(p => {
          if (p >= 100) {
            clearInterval(intervalRef.current!)
            setPlaying(false)
            return 100
          }
          return p + 100 / (clip.durationSec * 10)
        })
      }, 100)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing, clip.durationSec])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') goNext()
      if (e.key === 'ArrowLeft') goPrev()
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goNext, goPrev])

  const progressSec = Math.round((progress / 100) * clip.durationSec)
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'rgba(4,0,4,0.97)', backdropFilter: 'blur(2px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="flex items-center gap-1.5 text-sm transition-colors hover:text-white" style={{ color: '#666', fontFamily: 'Inter, sans-serif' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            Back
          </button>
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)' }} />
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888' }}>
            {index + 1} <span style={{ color: '#444' }}>/ {clips.length}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5" style={{ fontFamily: 'Inter, sans-serif', color: '#666', border: '1px solid rgba(255,255,255,0.08)' }}>Share</button>
          <button className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5" style={{ fontFamily: 'Inter, sans-serif', color: '#666', border: '1px solid rgba(255,255,255,0.08)' }}>Download</button>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5" style={{ color: '#555' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      {/* Main viewer */}
      <div className="flex flex-1 overflow-hidden">
        <button onClick={goPrev} disabled={index === 0} className="flex items-center justify-center px-4 transition-all shrink-0" style={{ color: index === 0 ? '#333' : '#666', cursor: index === 0 ? 'default' : 'pointer' }}>
          <div className="flex flex-col items-center gap-1 hover:text-white transition-colors" style={{ color: 'inherit' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M13 4L7 10l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span style={{ fontSize: 9, fontFamily: 'Inter, sans-serif', letterSpacing: '0.05em', color: 'inherit' }}>PREV</span>
          </div>
        </button>

        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-4">
          <div className="relative w-full rounded-xl overflow-hidden cursor-pointer" style={{ maxWidth: 900, aspectRatio: '16/9', background: '#0d000d' }} onClick={() => setPlaying(p => !p)}>
            <img src={clip.thumb} alt={clip.title} className="w-full h-full object-cover" style={{ opacity: 0.9 }} />

            {!playing && (
              <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.25)' }}>
                <div className="w-16 h-16 rounded-full flex items-center justify-center transition-transform hover:scale-105" style={{ background: '#e8192c', boxShadow: '0 0 0 1px rgba(232,25,44,0.3), 0 8px 32px rgba(232,25,44,0.4)' }}>
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><polygon points="7,4 19,11 7,18" fill="white" /></svg>
                </div>
              </div>
            )}

            {playing && (
              <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity" style={{ background: 'rgba(0,0,0,0.2)' }}>
                <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.55)' }}>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <rect x="3" y="3" width="4" height="12" rx="1" fill="white" />
                    <rect x="11" y="3" width="4" height="12" rx="1" fill="white" />
                  </svg>
                </div>
              </div>
            )}

            <div className="absolute top-3 left-3 px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#ccc' }}>{clip.game}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="w-full" style={{ maxWidth: 900 }}>
            <div className="group relative mb-3">
              <div className="w-full h-1 rounded-full cursor-pointer transition-all group-hover:h-1.5" style={{ background: 'rgba(255,255,255,0.1)' }}
                onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setProgress(((e.clientX - rect.left) / rect.width) * 100) }}>
                <div className="h-full rounded-full relative" style={{ width: `${progress}%`, background: '#e8192c' }}>
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: '#e8192c', transform: 'translateY(-50%) translateX(50%)' }} />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button onClick={() => setPlaying(p => !p)} style={{ color: 'white' }}>
                  {playing
                    ? <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="3" y="2" width="4" height="14" rx="1" fill="currentColor"/><rect x="11" y="2" width="4" height="14" rx="1" fill="currentColor"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><polygon points="4,2 16,9 4,16" fill="currentColor"/></svg>
                  }
                </button>
                <div className="flex items-center gap-1">
                  <button onClick={goPrev} disabled={index === 0} style={{ color: index === 0 ? '#444' : '#aaa' }} className="transition-colors hover:text-white disabled:cursor-default">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="2.5" height="10" rx="1" fill="currentColor"/><path d="M13 3L7 8l6 5V3z" fill="currentColor"/></svg>
                  </button>
                  <button onClick={goNext} disabled={index === clips.length - 1} style={{ color: index === clips.length - 1 ? '#444' : '#aaa' }} className="transition-colors hover:text-white disabled:cursor-default">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="11.5" y="3" width="2.5" height="10" rx="1" fill="currentColor"/><path d="M3 3l6 5-6 5V3z" fill="currentColor"/></svg>
                  </button>
                </div>
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#666', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(progressSec)} <span style={{ color: '#333' }}>/ {clip.duration}</span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => setLiked(l => !l)} className="flex items-center gap-1.5 transition-all" style={{ color: liked ? '#e8192c' : '#666' }}>
                  <svg width="15" height="15" viewBox="0 0 15 15" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3"><path d="M7.5 12.5L2 7c-.8-.9-.8-2.2 0-3 .8-.9 2.2-.9 3 0L7.5 6l2.5-2c.8-.9 2.2-.9 3 0 .8.8.8 2.1 0 3L7.5 12.5z"/></svg>
                  <span style={{ fontSize: 11, fontFamily: 'Inter, sans-serif' }}>{clip.likes}</span>
                </button>
                <button style={{ color: '#666' }} className="transition-colors hover:text-white">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="12" cy="3" r="1.5"/><circle cx="3" cy="7.5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><path d="M4.5 6.5l6-2.5M4.5 8.5l6 2.5"/></svg>
                </button>
              </div>
            </div>
          </div>

          <div className="w-full flex items-start justify-between" style={{ maxWidth: 900 }}>
            <div>
              <h2 style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, color: '#f0f0f0', marginBottom: 4 }}>{clip.title}</h2>
              <div className="flex items-center gap-3" style={{ color: '#555', fontSize: 12, fontFamily: 'Inter, sans-serif' }}>
                <span>{clip.views} views</span>
                <span>·</span>
                <span>{clip.time}</span>
                <span>·</span>
                <span style={{ color: '#e8192c' }}>{clip.game}</span>
              </div>
            </div>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#444' }}>← → Space Esc</span>
          </div>
        </div>

        <button onClick={goNext} disabled={index === clips.length - 1} className="flex items-center justify-center px-4 shrink-0 transition-all" style={{ color: index === clips.length - 1 ? '#333' : '#666', cursor: index === clips.length - 1 ? 'default' : 'pointer' }}>
          <div className="flex flex-col items-center gap-1 hover:text-white transition-colors" style={{ color: 'inherit' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span style={{ fontSize: 9, fontFamily: 'Inter, sans-serif', letterSpacing: '0.05em', color: 'inherit' }}>NEXT</span>
          </div>
        </button>
      </div>

      {/* Clip strip */}
      <div className="shrink-0 px-5 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          {clips.map((c, i) => (
            <button key={c.id} onClick={() => { setIndex(i); setProgress(0); setPlaying(false) }}
              className="shrink-0 relative rounded overflow-hidden transition-all"
              style={{ width: 96, aspectRatio: '16/9', outline: i === index ? '2px solid #e8192c' : '2px solid transparent', outlineOffset: 1, opacity: i === index ? 1 : 0.5 }}>
              <img src={c.thumb} alt={c.title} className="w-full h-full object-cover" />
              <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1" style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.8))' }}>
                <p style={{ fontSize: 9, color: '#ccc', fontFamily: 'Inter, sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── TopBar ─────────────────────────────────────────────────────────────────────

function TopBar({ active, setActive, isRecording }: { active: string; setActive: (c: string) => void; isRecording: boolean }) {
  return (
    <header className="flex items-center shrink-0 px-4 titlebar-drag" style={{ height: 48, background: '#0c000c', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2 mr-6 titlebar-no-drag">
        <div style={{ color: '#e8192c' }}><StickmanIcon size={20} /></div>
        <span style={{ fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: 15, color: '#f0f0f0', letterSpacing: '-0.01em' }}>
          flash<span style={{ color: '#e8192c' }}>.</span>
        </span>
      </div>

      <nav className="flex items-stretch h-full titlebar-no-drag">
        {CATEGORIES.map(cat => (
          <button key={cat} onClick={() => setActive(cat)}
            className="relative px-4 text-sm transition-colors duration-100"
            style={{ fontFamily: 'Inter, sans-serif', fontWeight: active === cat ? 500 : 400, fontSize: 13, color: active === cat ? '#f0f0f0' : '#555', borderBottom: `2px solid ${active === cat ? '#e8192c' : 'transparent'}` }}>
            {cat}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-3 titlebar-no-drag">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md" style={{ background: isRecording ? 'rgba(232,25,44,0.1)' : 'rgba(255,255,255,0.03)', border: `1px solid ${isRecording ? 'rgba(232,25,44,0.2)' : 'rgba(255,255,255,0.06)'}` }}>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: isRecording ? '#e8192c' : '#444', animation: isRecording ? 'pulse-red 1.4s ease-in-out infinite' : 'none' }} />
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: isRecording ? '#e8192c' : '#444', fontWeight: 500 }}>
            {isRecording ? 'REC' : 'IDLE'}
          </span>
        </div>
        <kbd style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#444', background: '#111', border: '1px solid #222', borderRadius: 4, padding: '2px 6px' }}>F8</kbd>
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: '#e8192c', color: 'white', fontFamily: 'Inter, sans-serif', fontSize: 11 }}>
          FL
        </div>
      </div>
    </header>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

function Sidebar({ gameFilter, setGameFilter }: { gameFilter: string; setGameFilter: (g: string) => void }) {
  return (
    <aside className="flex flex-col shrink-0 overflow-y-auto" style={{ width: 196, background: '#080008', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="p-3">
        <button className="w-full py-2 rounded-lg text-sm font-semibold transition-all hover:brightness-110 active:scale-95 mb-4"
          style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13, background: '#e8192c', color: 'white' }}>
          + New Clip
        </button>

        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#333', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 8 }}>Games</p>

        {GAMES.map(g => (
          <button key={g.name} onClick={() => setGameFilter(g.name)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all duration-100 text-left mb-0.5"
            style={{ background: gameFilter === g.name ? 'rgba(232,25,44,0.1)' : 'transparent', color: gameFilter === g.name ? '#f0f0f0' : '#555' }}>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: gameFilter === g.name ? 500 : 400 }}>{g.name}</span>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#333' }}>{g.clips}</span>
          </button>
        ))}

        <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '12px 0' }} />

        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#333', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 8 }}>Storage</p>
        <div className="px-3 pb-1">
          <div className="w-full h-1 rounded-full mb-1.5" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div className="h-full rounded-full" style={{ width: '58%', background: '#e8192c', opacity: 0.8 }} />
          </div>
          <div className="flex justify-between">
            <span style={{ fontSize: 10, color: '#333', fontFamily: 'Inter, sans-serif' }}>14.2 GB used</span>
            <span style={{ fontSize: 10, color: '#333', fontFamily: 'Inter, sans-serif' }}>25 GB</span>
          </div>
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '12px 0' }} />

        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#333', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 8 }}>Recent Activity</p>
        {[
          { user: 'xKhronos', action: 'liked your clip', time: '3m' },
          { user: 'ShadowAce', action: 'followed you', time: '12m' },
          { user: 'blaze_99', action: 'commented', time: '28m' },
        ].map((a, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5">
            <div className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-xs font-bold" style={{ background: 'rgba(232,25,44,0.15)', color: '#e8192c', fontFamily: 'Inter, sans-serif', fontSize: 9 }}>
              {a.user[0]}
            </div>
            <div>
              <p style={{ fontSize: 11, color: '#444', fontFamily: 'Inter, sans-serif', lineHeight: 1.3 }}>
                <span style={{ color: '#888' }}>{a.user}</span> {a.action}
              </p>
              <p style={{ fontSize: 10, color: '#2a2a2a', fontFamily: 'Inter, sans-serif' }}>{a.time}</p>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

// ── ClipCard ───────────────────────────────────────────────────────────────────

function ClipCard({ clip, onClick }: { clip: Clip; onClick: () => void }) {
  const [hov, setHov] = useState(false)

  return (
    <div className="rounded-xl overflow-hidden cursor-pointer transition-all duration-150"
      style={{ background: '#0e000e', border: `1px solid ${hov ? 'rgba(232,25,44,0.3)' : 'rgba(255,255,255,0.05)'}`, transform: hov ? 'translateY(-1px)' : 'none', boxShadow: hov ? '0 4px 20px rgba(0,0,0,0.5)' : 'none' }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onClick}>
      <div className="relative overflow-hidden" style={{ aspectRatio: '16/9', background: '#0a0008' }}>
        <img src={clip.thumb} alt={clip.title} className="w-full h-full object-cover transition-transform duration-300" style={{ transform: hov ? 'scale(1.03)' : 'scale(1)' }} />
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(2px)' }}>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#ccc' }}>{clip.duration}</span>
        </div>
        {hov && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.35)' }}>
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#e8192c', boxShadow: '0 0 20px rgba(232,25,44,0.5)' }}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><polygon points="3,1 11,6.5 3,12" fill="white"/></svg>
            </div>
          </div>
        )}
        <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888' }}>{clip.game}</span>
        </div>
      </div>
      <div className="p-3">
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 500, color: '#d0d0d0', marginBottom: 6, lineHeight: 1.4 }} className="line-clamp-1">{clip.title}</p>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3" style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#444' }}>
            <span>{clip.views}</span>
            <span>{clip.likes} ♥</span>
          </div>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#2f2f2f' }}>{clip.time}</span>
        </div>
      </div>
    </div>
  )
}

// ── ClipsPanel ─────────────────────────────────────────────────────────────────

function ClipsPanel({ clips, onOpenClip }: { clips: Clip[]; onOpenClip: (index: number) => void }) {
  const [sort, setSort] = useState('Recent')
  const sorts = ['Recent', 'Most Viewed', 'Most Liked', 'Longest']

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-1.5">
          {sorts.map(s => (
            <button key={s} onClick={() => setSort(s)}
              className="px-3 py-1.5 rounded-lg text-xs transition-all duration-100"
              style={{ fontFamily: 'Inter, sans-serif', fontWeight: sort === s ? 500 : 400, background: sort === s ? 'rgba(232,25,44,0.12)' : 'rgba(255,255,255,0.03)', color: sort === s ? '#f0f0f0' : '#555', border: `1px solid ${sort === s ? 'rgba(232,25,44,0.25)' : 'rgba(255,255,255,0.04)'}` }}>
              {s}
            </button>
          ))}
        </div>
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#333' }}>{clips.length} clips</span>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
        {clips.map((clip, i) => <ClipCard key={clip.id} clip={clip} onClick={() => onOpenClip(i)} />)}
      </div>
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

function SettingsPanel() {
  const [quality, setQuality] = useState('1080p 60fps')
  const [clipLen, setClipLen] = useState(30)
  const [autoSave, setAutoSave] = useState(true)
  const [audio, setAudio] = useState(true)
  const [notifs, setNotifs] = useState(true)
  const [likesNotif, setLikesNotif] = useState(true)
  const [followsNotif, setFollowsNotif] = useState(true)

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888' }}>{label}</span>
      {children}
    </div>
  )

  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded-xl p-5" style={{ background: '#0e000e', border: '1px solid rgba(255,255,255,0.05)' }}>
      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: '#e8192c', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{title}</p>
      {children}
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 18, color: '#f0f0f0', marginBottom: 2 }}>Settings</h1>
      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#444', marginBottom: 24 }}>Configure your Flash recording preferences</p>

      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card title="Capture">
          <Row label="Hotkey">
            <kbd style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#e8192c', background: 'rgba(232,25,44,0.1)', border: '1px solid rgba(232,25,44,0.25)', borderRadius: 4, padding: '2px 8px' }}>F8</kbd>
          </Row>
          <Row label="Quality">
            <select value={quality} onChange={e => setQuality(e.target.value)}
              style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ccc', background: '#1a001a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '3px 8px' }}>
              <option>720p 30fps</option>
              <option>1080p 60fps</option>
              <option>1440p 60fps</option>
              <option>4K 30fps</option>
            </select>
          </Row>
          <Row label={`Clip length — ${clipLen}s`}>
            <input type="range" min={10} max={120} value={clipLen} onChange={e => setClipLen(+e.target.value)} style={{ accentColor: '#e8192c', width: 90 }} />
          </Row>
          <Row label="Audio capture"><Toggle on={audio} onChange={() => setAudio(!audio)} /></Row>
          <Row label="Auto-save clips"><Toggle on={autoSave} onChange={() => setAutoSave(!autoSave)} /></Row>
        </Card>

        <Card title="Notifications">
          <Row label="Push notifications"><Toggle on={notifs} onChange={() => setNotifs(!notifs)} /></Row>
          <Row label="Clip likes"><Toggle on={likesNotif} onChange={() => setLikesNotif(!likesNotif)} /></Row>
          <Row label="New followers"><Toggle on={followsNotif} onChange={() => setFollowsNotif(!followsNotif)} /></Row>
          <Row label="Comments"><Toggle on={false} onChange={() => {}} /></Row>
          <Row label="Weekly recap"><Toggle on={true} onChange={() => {}} /></Row>
        </Card>

        <Card title="Storage">
          <div className="mb-4 pt-2">
            <div className="flex justify-between mb-2">
              <span style={{ fontSize: 12, color: '#666', fontFamily: 'Inter, sans-serif' }}>14.2 GB of 25 GB used</span>
              <span style={{ fontSize: 11, color: '#e8192c', fontFamily: 'Inter, sans-serif' }}>58%</span>
            </div>
            <div className="w-full h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div className="h-full rounded-full" style={{ width: '58%', background: '#e8192c' }} />
            </div>
          </div>
          <Row label="Auto-delete after"><span style={{ fontSize: 12, color: '#666', fontFamily: 'Inter, sans-serif' }}>30 days</span></Row>
          <Row label="Export format"><span style={{ fontSize: 12, color: '#666', fontFamily: 'Inter, sans-serif' }}>MP4 / H.264</span></Row>
          <button className="mt-4 w-full py-2 rounded-lg text-xs transition-all hover:bg-white/5"
            style={{ fontFamily: 'Inter, sans-serif', fontWeight: 500, color: '#555', border: '1px solid rgba(255,255,255,0.07)' }}>
            Manage Storage
          </button>
        </Card>

        <Card title="Account">
          <div className="flex items-center gap-3 p-3 rounded-lg my-2" style={{ background: 'rgba(232,25,44,0.06)', border: '1px solid rgba(232,25,44,0.12)' }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold" style={{ background: '#e8192c', color: 'white', fontFamily: 'Inter, sans-serif', fontSize: 13 }}>FL</div>
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#f0f0f0', fontFamily: 'Inter, sans-serif' }}>Flash User</p>
              <p style={{ fontSize: 10, color: '#444', fontFamily: 'Inter, sans-serif' }}>Local Mode</p>
            </div>
          </div>
          <Row label="Clips folder"><span style={{ fontSize: 12, color: '#555', fontFamily: 'Inter, sans-serif' }}>~/Videos/Flash</span></Row>
          <Row label="Privacy"><span style={{ fontSize: 12, color: '#555', fontFamily: 'Inter, sans-serif' }}>Local</span></Row>
          <button className="mt-4 w-full py-2 rounded-lg text-xs transition-all hover:brightness-110"
            style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, background: '#e8192c', color: 'white' }}>
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
  const [gameFilter, setGameFilter] = useState('All Games')
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [isRecording, setIsRecording] = useState(false)

  // Filter clips by game
  const filteredClips = gameFilter === 'All Games'
    ? CLIPS
    : CLIPS.filter(c => c.game === gameFilter)

  // Wire up Electron IPC if available
  useEffect(() => {
    if (typeof window !== 'undefined' && window.flash) {
      window.flash.onRecordingState(state => setIsRecording(state))
      window.flash.onNavigate(page => setActive(page))
      window.flash.getRecordingState().then(setIsRecording)
    }
  }, [])

  return (
    <div className="flex flex-col" style={{ width: '100vw', height: '100vh', background: '#060006', overflow: 'hidden' }}>
      <TopBar active={active} setActive={setActive} isRecording={isRecording} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar gameFilter={gameFilter} setGameFilter={setGameFilter} />
        <main className="flex-1 flex flex-col overflow-hidden" style={{ background: '#080008' }}>
          {active === 'Settings'
            ? <SettingsPanel />
            : <ClipsPanel clips={filteredClips} onOpenClip={i => setPreviewIndex(i)} />
          }
        </main>
      </div>
      {previewIndex !== null && (
        <ClipPreview clips={filteredClips} startIndex={previewIndex} onClose={() => setPreviewIndex(null)} />
      )}
    </div>
  )
}
