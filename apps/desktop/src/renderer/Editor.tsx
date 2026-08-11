import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipActionBar } from './ClipActionBar'
import { AudioLanes } from './editor/AudioLanes'
import { Filmstrip } from './editor/Filmstrip'
import { useLiveMix } from './editor/useLiveMix'
import type { LiveMixTrack } from './editor/useLiveMix'
import { clampRange, formatTimecode, nearestKeyframe } from '../shared/editor'
import type { ClipInfo } from '../preload/preload'

const SPEEDS = [0.5, 1, 1.5, 2] as const

// A finisher, not an editor: one clip in, one clip out. No browser chrome on
// this screen - no <video controls>, no <select>, no number spinners - because
// looking like Chrome is the thing it is here to stop doing.
export default function Editor({ clip, onClose }: { clip: ClipInfo; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(clip.durationSec || 0)
  const [speed, setSpeed] = useState<number>(1)
  const [range, setRange] = useState({ inSec: 0, outSec: clip.durationSec || 0 })
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [audioTracks, setAudioTracks] = useState<LiveMixTrack[]>([])
  const [gains, setGains] = useState<Record<string, number>>({})
  const [mutedTracks, setMutedTracks] = useState<Set<string>>(new Set())

  // Keyframes come from a full pass over the file, so they arrive a moment
  // after the screen does. Until then the strip simply has no ticks and no
  // snapping, which degrades quietly rather than blocking the editor.
  useEffect(() => {
    let cancelled = false
    window.flash?.getClipKeyframes(clip.filePath).then(result => {
      if (cancelled || !result || result.error) return
      setKeyframes(result.keyframesSec ?? [])
      if (result.durationSeconds > 0) {
        setDuration(current => current > 0 ? current : result.durationSeconds)
        setRange(current => current.outSec > 0 ? current : { inSec: 0, outSec: result.durationSeconds })
      }
    })
    return () => { cancelled = true }
  }, [clip.filePath])

  useEffect(() => {
    let cancelled = false
    setAudioTracks([])
    setGains({})
    setMutedTracks(new Set())

    window.flash?.decodeClipAudio(clip.filePath).then(result => {
      if (cancelled) return
      if (result.error) {
        console.error(`Could not decode audio for ${clip.filePath}: ${result.error}`)
        return
      }

      const decoded = result.tracks.map(track => ({
        ...track,
        sampleRate: result.sampleRate,
      }))
      setAudioTracks(decoded)
      setGains(Object.fromEntries(decoded.map(track => [track.id, 1])))
    }).catch(error => {
      if (!cancelled) console.error(`Could not decode audio for ${clip.filePath}`, error)
    })

    return () => { cancelled = true }
  }, [clip.filePath])

  const liveGains = useMemo(() => Object.fromEntries(
    audioTracks.map(track => [track.id, mutedTracks.has(track.id) ? 0 : (gains[track.id] ?? 1)]),
  ), [audioTracks, gains, mutedTracks])
  const { ready: mixReady } = useLiveMix(videoRef, audioTracks, liveGains)

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current
    if (video) video.currentTime = seconds
    setCurrent(seconds)
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => { /* autoplay policy */ })
    else video.pause()
  }, [])

  // Escape closes and Space toggles play. Left and right deliberately do
  // nothing here: they move between clips in the player, and carrying that
  // into the editor would let a stray keypress swap the clip out from under
  // an in-progress edit.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return
      if (event.key === 'Escape') onClose()
      if (event.code === 'Space') { event.preventDefault(); togglePlay() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, togglePlay])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = speed
  }, [speed])

  const source = `file://${clip.filePath.replace(/\\/g, '/')}`

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'color-mix(in srgb, var(--bg) 97%, transparent)' }}>
      <ClipActionBar filePath={clip.filePath} onClose={onClose} backLabel="Back" middle={
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{clip.title}</span>
      } />

      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-4 overflow-hidden" aria-busy={audioTracks.length > 0 && !mixReady}>
        <video
          ref={videoRef}
          key={clip.filePath}
          src={source}
          muted
          className="rounded-xl"
          style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 290px)', background: '#000' }}
          onLoadedMetadata={event => {
            const length = event.currentTarget.duration || clip.durationSec || 0
            setDuration(length)
            setRange(current => current.outSec > 0 ? current : { inSec: 0, outSec: length })
          }}
          onTimeUpdate={event => setCurrent(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={togglePlay}
        />

        <Filmstrip
          filePath={clip.filePath}
          durationSec={duration}
          inSec={range.inSec}
          outSec={range.outSec}
          currentSec={current}
          keyframesSec={keyframes}
          onChange={next => setRange(clampRange(next.inSec, next.outSec, duration))}
          onScrub={seekTo}
        />

        <AudioLanes
          tracks={audioTracks}
          gains={gains}
          muted={mutedTracks}
          onGainChange={(id, gain) => setGains(current => ({ ...current, [id]: gain }))}
          onMuteToggle={id => setMutedTracks(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })}
        />

        <div className="w-full flex items-center gap-3" style={{ maxWidth: 900 }}>
          <button onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
            className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5"
            style={{ color: 'var(--accent)' }}>
            {playing
              ? <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="1" width="3.5" height="12" rx="1"/><rect x="8.5" y="1" width="3.5" height="12" rx="1"/></svg>
              : <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 1.8v10.4c0 .7.8 1.1 1.4.7l8-5.2a.85.85 0 000-1.4l-8-5.2c-.6-.4-1.4 0-1.4.7z"/></svg>}
          </button>

          <span style={{ fontSize: 12, color: 'var(--muted-2)', fontVariantNumeric: 'tabular-nums' }}>
            {formatTimecode(current)} <span style={{ color: 'var(--muted-3)' }}>/ {formatTimecode(duration)}</span>
          </span>

          {/* Preview only. Baking speed into the saved file means re-encoding
              and pitch-correcting three audio tracks, which is not what this
              screen is for. */}
          <span className="ml-auto flex items-center gap-1">
            {SPEEDS.map(value => (
              <button key={value} onClick={() => setSpeed(value)}
                aria-pressed={speed === value}
                className="px-2 py-1 rounded-md text-xs transition-all hover:bg-white/5"
                style={{
                  color: speed === value ? 'var(--on-accent)' : 'var(--muted-2)',
                  background: speed === value ? 'var(--accent)' : 'transparent',
                  border: `1px solid ${speed === value ? 'var(--accent)' : 'var(--edge-soft)'}`,
                }}>
                {value}x
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderTop: '1px solid var(--edge-soft)' }}>
        <span style={{ fontSize: 12, color: 'var(--muted-2)', fontVariantNumeric: 'tabular-nums' }}>
          {formatTimecode(range.inSec)} → {formatTimecode(range.outSec)}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted-3)' }}>{(range.outSec - range.inSec).toFixed(1)}s</span>
        {/* Honest about what the save will cost. An in-point on a keyframe is a
            pure remux; anywhere else re-encodes the first GOP. */}
        {keyframes.length > 0 && (
          nearestKeyframe(keyframes, range.inSec, 0.001) !== null
            ? <span style={{ fontSize: 11, color: 'var(--accent)' }}>lossless</span>
            : <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>re-encodes the first second</span>
        )}
        <span className="ml-auto">
          <button disabled title="Trimming and the audio mixer land in the next step"
            className="px-4 py-1.5 rounded-md text-xs"
            style={{ color: 'var(--muted-3)', border: '1px solid var(--edge-soft)', cursor: 'default' }}>
            Save
          </button>
        </span>
      </div>
    </div>
  )
}
