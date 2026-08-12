import { useCallback, useEffect, useRef, useState } from 'react'
import { clampRange, clipUrl, nearestKeyframe } from '../../shared/editor'

const THUMBNAIL_COUNT = 10

// How close a dragged handle has to get before it snaps onto a keyframe. Wide
// enough to be reachable by hand, narrow enough that a deliberate mid-GOP cut
// still lands where you put it.
const SNAP_SEC = 0.15

type Handle = 'in' | 'out'

// Thumbnails are painted from ONE video element seeked across the clip, not one
// element per thumbnail. Chromium caps how many videos can decode at once, and
// the library grid behind this screen already holds one per clip; adding ten
// more pushed past the limit and every video on screen - including the preview
// - silently painted black.
function useFilmstripThumbnails(source: string, durationSec: number, canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || durationSec <= 0) return

    let cancelled = false
    const video = document.createElement('video')
    video.src = source
    video.muted = true
    video.preload = 'auto'

    const paint = async () => {
      const context = canvas.getContext('2d')
      if (!context) return
      const width = canvas.width / THUMBNAIL_COUNT
      const height = canvas.height

      for (let i = 0; i < THUMBNAIL_COUNT && !cancelled; i++) {
        const at = durationSec * ((i + 0.5) / THUMBNAIL_COUNT)
        const seeked = new Promise<void>(resolve => {
          const done = () => { video.removeEventListener('seeked', done); resolve() }
          video.addEventListener('seeked', done)
          setTimeout(done, 2000)   // a seek that never lands must not stall the strip
        })
        video.currentTime = at
        await seeked
        if (cancelled) return
        try {
          context.drawImage(video, i * width, 0, width, height)
        } catch { /* frame not decodable yet; leave that slice empty */ }
      }
    }

    const start = () => { void paint() }
    video.addEventListener('loadeddata', start)

    return () => {
      cancelled = true
      video.removeEventListener('loadeddata', start)
      video.removeAttribute('src')
      video.load()   // releases the decoder rather than waiting for GC
    }
  }, [source, durationSec, canvasRef])
}

// The scrubber.
export function Filmstrip({ filePath, durationSec, inSec, outSec, currentSec, keyframesSec, onChange, onScrub }: {
  filePath: string
  durationSec: number
  inSec: number
  outSec: number
  currentSec: number
  keyframesSec: number[]
  onChange: (range: { inSec: number; outSec: number }) => void
  onScrub: (seconds: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dragging, setDragging] = useState<Handle | null>(null)
  const source = clipUrl(filePath)
  const safeDuration = durationSec > 0 ? durationSec : 0
  const percent = (seconds: number) => safeDuration > 0 ? (seconds / safeDuration) * 100 : 0

  useFilmstripThumbnails(source, safeDuration, canvasRef)

  const secondsAt = useCallback((clientX: number) => {
    const track = trackRef.current
    if (!track || safeDuration <= 0) return 0
    const box = track.getBoundingClientRect()
    const ratio = (clientX - box.left) / box.width
    return Math.min(Math.max(ratio, 0), 1) * safeDuration
  }, [safeDuration])

  const moveHandle = useCallback((handle: Handle, seconds: number) => {
    const snapped = nearestKeyframe(keyframesSec, seconds, SNAP_SEC) ?? seconds
    onChange(handle === 'in'
      ? clampRange(snapped, outSec, safeDuration)
      : clampRange(inSec, snapped, safeDuration))
  }, [keyframesSec, inSec, outSec, safeDuration, onChange])

  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent) => moveHandle(dragging, secondsAt(event.clientX))
    const onUp = () => setDragging(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, moveHandle, secondsAt])

  // A handle that can only be dragged is unusable without a mouse. Arrows act
  // only while a handle holds focus, so they cannot fire by accident elsewhere
  // on the screen.
  const onHandleKey = (handle: Handle) => (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 1 : 1 / 60
    const from = handle === 'in' ? inSec : outSec
    if (event.key === 'ArrowLeft') { event.preventDefault(); moveHandle(handle, from - step) }
    if (event.key === 'ArrowRight') { event.preventDefault(); moveHandle(handle, from + step) }
  }

  const handleStyle = (seconds: number, side: Handle): React.CSSProperties => ({
    position: 'absolute',
    top: -3,
    bottom: -3,
    left: `${percent(seconds)}%`,
    width: 10,
    marginLeft: -5,
    borderRadius: 3,
    background: 'var(--accent)',
    border: '1px solid color-mix(in srgb, var(--accent) 60%, black)',
    cursor: 'ew-resize',
    padding: 0,
    touchAction: 'none',
    boxShadow: dragging === side ? '0 0 0 3px var(--accent-line)' : 'none',
  })

  return (
    <div className="w-full select-none" style={{ maxWidth: 900 }}>
      <div
        ref={trackRef}
        className="relative"
        style={{ height: 56, borderRadius: 6, overflow: 'visible' }}
        onPointerDown={event => {
          if ((event.target as HTMLElement).dataset.handle) return
          onScrub(secondsAt(event.clientX))
        }}>

        <canvas
          ref={canvasRef}
          width={THUMBNAIL_COUNT * 96}
          height={54}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full"
          style={{ borderRadius: 6, background: '#000' }}
        />

        {/* Everything outside the selection is dimmed rather than hidden, so
            you can still see what you are cutting away. */}
        <div className="absolute pointer-events-none" style={{ top: 0, bottom: 0, left: 0, width: `${percent(inSec)}%`, background: 'color-mix(in srgb, var(--bg) 72%, transparent)', borderRadius: '6px 0 0 6px' }} />
        <div className="absolute pointer-events-none" style={{ top: 0, bottom: 0, right: 0, width: `${100 - percent(outSec)}%`, background: 'color-mix(in srgb, var(--bg) 72%, transparent)', borderRadius: '0 6px 6px 0' }} />

        <div className="absolute pointer-events-none" style={{ top: 0, bottom: 0, left: `${percent(currentSec)}%`, width: 2, marginLeft: -1, background: 'var(--fg)', opacity: 0.9 }} />

        <button data-handle="in" aria-label="Trim start" tabIndex={0}
          onPointerDown={event => { event.preventDefault(); setDragging('in') }}
          onKeyDown={onHandleKey('in')}
          style={handleStyle(inSec, 'in')} />
        <button data-handle="out" aria-label="Trim end" tabIndex={0}
          onPointerDown={event => { event.preventDefault(); setDragging('out') }}
          onKeyDown={onHandleKey('out')}
          style={handleStyle(outSec, 'out')} />
      </div>

      {/* Where a cut can stay lossless. Land both handles on ticks and the save
          is a pure remux; anywhere else costs a re-encode of the first GOP. */}
      <div className="relative" style={{ height: 7, marginTop: 5 }}>
        {keyframesSec.map(at => (
          <span key={at} className="absolute" title={`keyframe at ${at.toFixed(2)}s`}
            style={{ left: `${percent(at)}%`, top: 0, width: 1, height: 7, background: 'var(--spark)', opacity: 0.55 }} />
        ))}
      </div>
    </div>
  )
}
