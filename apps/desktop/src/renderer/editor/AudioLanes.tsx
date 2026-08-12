import { useEffect, useRef } from 'react'
import { reducePeaks } from '../../shared/editor'
import type { LiveMixTrack } from './useLiveMix'

function TrackIcon({ id }: { id: string }) {
  if (id === 'mic') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <rect x="5" y="1.5" width="6" height="9" rx="3" />
        <path d="M3 8.5a5 5 0 0010 0M8 13.5V15M5.5 15h5" />
      </svg>
    )
  }
  if (id === 'other') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 3.5h12v8H7l-3.5 2v-2H2z" />
        <path d="M5 6.5h6M5 8.5h4" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 5h6c2.2 0 3.4 1.7 3.4 4.1 0 2.1-.8 3.4-2 3.4-.8 0-1.7-1.2-2.4-2H6c-.7.8-1.6 2-2.4 2-1.2 0-2-1.3-2-3.4C1.6 6.7 2.8 5 5 5z" />
      <path d="M5 7v3M3.5 8.5h3M10.8 7.8h.1M12.3 9.2h.1" />
    </svg>
  )
}

function Waveform({ track }: { track: LiveMixTrack }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const bounds = canvas.getBoundingClientRect()
      const width = Math.max(1, Math.floor(bounds.width))
      const height = Math.max(1, Math.floor(bounds.height))
      const scale = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)

      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.clearRect(0, 0, width, height)

      const styles = getComputedStyle(canvas)
      const center = height / 2
      if (track.samples.length === 0) {
        context.fillStyle = styles.getPropertyValue('--edge').trim()
        context.fillRect(0, Math.floor(center), width, 1)
        return
      }

      const buckets = Math.max(1, Math.floor((width + 1) / 2))
      const peaks = reducePeaks(track.samples, buckets)
      context.fillStyle = styles.getPropertyValue('--accent').trim()
      const maxHalfHeight = Math.max(0.5, center - 2)
      for (let index = 0; index < peaks.length; index++) {
        const halfHeight = Math.max(0.5, Math.min(1, peaks[index]) * maxHalfHeight)
        context.fillRect(index * 2, center - halfHeight, 1, halfHeight * 2)
      }
    }

    draw()
    const resize = new ResizeObserver(draw)
    resize.observe(canvas)

    // Canvas cannot read a CSS variable, so the accent colour is baked in at
    // paint time. Switching theme changes that variable without touching the
    // canvas, which would leave the waveform in the old theme's colour until
    // something else forced a repaint.
    const theme = new MutationObserver(draw)
    theme.observe(document.documentElement, { attributeFilter: ['data-theme'] })

    return () => { resize.disconnect(); theme.disconnect() }
  }, [track])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`${track.id} audio waveform`}
      className="block w-full"
      style={{ height: 34 }}
    />
  )
}

const LANE_SHELL = 'w-full overflow-hidden rounded-lg'
const LANE_GRID = '32px 54px minmax(80px, 1fr) 112px 42px'
// Every clip carries these three, so the placeholder can name them rather than
// showing anonymous grey bars.
const EXPECTED_TRACKS = ['game', 'mic', 'other'] as const

export function AudioLanes({ tracks, gains, onGainChange, muted, onMuteToggle, loading }: {
  tracks: LiveMixTrack[]
  gains: Record<string, number>
  onGainChange: (id: string, gain: number) => void
  muted: ReadonlySet<string>
  onMuteToggle: (id: string) => void
  loading?: boolean
}) {
  if (tracks.length === 0 && loading) {
    return (
      <div className={LANE_SHELL} style={{ maxWidth: 900, background: 'var(--panel)', border: '1px solid var(--edge-soft)' }}>
        {EXPECTED_TRACKS.map((id, index) => (
          <div key={id} className="grid items-center gap-3 px-3"
            style={{ gridTemplateColumns: LANE_GRID, minHeight: 48, borderTop: index === 0 ? 'none' : '1px solid var(--edge-soft)' }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-md"
              style={{ color: 'var(--muted-3)', background: 'var(--field)', border: '1px solid var(--edge-soft)' }}>
              <TrackIcon id={id} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {id}
            </span>
            <span className="lane-skeleton" style={{ height: 6 }} aria-hidden="true" />
            <span className="lane-skeleton" style={{ height: 3, width: 112 }} aria-hidden="true" />
            <span style={{ fontSize: 11, color: 'var(--muted-3)', textAlign: 'right' }}>…</span>
          </div>
        ))}
        <span className="sr-only" role="status">Reading the clip's audio tracks</span>
      </div>
    )
  }

  if (tracks.length === 0) return null

  return (
    <div className={LANE_SHELL} style={{ maxWidth: 900, background: 'var(--panel)', border: '1px solid var(--edge-soft)' }}>
      {tracks.map((track, index) => {
        const disabled = track.samples.length === 0
        const isMuted = muted.has(track.id)
        const gain = gains[track.id] ?? 1
        return (
          <div
            key={track.id}
            className="grid items-center gap-3 px-3 transition-opacity"
            style={{
              gridTemplateColumns: LANE_GRID,
              minHeight: 48,
              borderTop: index === 0 ? 'none' : '1px solid var(--edge-soft)',
              opacity: isMuted ? 0.35 : disabled ? 0.5 : 1,
            }}>
            <button
              type="button"
              disabled={disabled}
              aria-label={isMuted ? `Unmute ${track.id}` : `Mute ${track.id}`}
              aria-pressed={isMuted}
              onClick={() => onMuteToggle(track.id)}
              className="relative flex h-8 w-8 items-center justify-center rounded-md"
              style={{ color: isMuted ? 'var(--muted)' : 'var(--accent)', background: 'var(--field)', border: '1px solid var(--edge-soft)', cursor: disabled ? 'default' : 'pointer' }}>
              <TrackIcon id={track.id} />
              {isMuted && (
                <svg className="absolute inset-0 m-auto" width="21" height="21" viewBox="0 0 21 21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 4l13 13M17 4L4 17" />
                </svg>
              )}
            </button>

            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {track.id}
            </span>

            <Waveform track={track} />

            <input
              className="audio-gain-range"
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={gain}
              disabled={disabled}
              aria-label={`${track.id} gain`}
              onChange={event => onGainChange(track.id, event.currentTarget.valueAsNumber)}
            />

            <span style={{ fontSize: 11, color: 'var(--muted-2)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {disabled ? '—' : `${Math.round(gain * 100)}%`}
            </span>
          </div>
        )
      })}
    </div>
  )
}
