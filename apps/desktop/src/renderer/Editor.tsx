import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipActionBar } from './ClipActionBar'
import { AudioLanes } from './editor/AudioLanes'
import { Filmstrip } from './editor/Filmstrip'
import { useLiveMix } from './editor/useLiveMix'
import type { LiveMixTrack } from './editor/useLiveMix'
import { clampRange, deriveSaveMode, formatTimecode, nearestKeyframe } from '../shared/editor'
import type { SaveReason } from '../shared/editor'
import type { ClipInfo } from '../preload/preload'

const SPEEDS = [0.5, 1, 1.5, 2] as const

const SAVE_NOTES: Record<SaveReason, string> = {
  none: 'lossless',
  trim: 're-encodes the first second',
  audio: 're-encodes audio',
  video: 're-encodes video — colour changed',
}

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
  const [saturation, setSaturation] = useState(100)
  const [saving, setSaving] = useState(false)
  const [saveNote, setSaveNote] = useState<string | null>(null)
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

  // The in-point counts as on a keyframe only when it lands exactly on one.
  // The native planner carries a half-frame tolerance of its own; this is
  // deliberately stricter so the badge never promises lossless and then costs
  // a re-encode.
  const saveMode = useMemo(
    () => deriveSaveMode(
      keyframes.length === 0 || nearestKeyframe(keyframes, range.inSec, 0.001) !== null,
      Object.values(liveGains),
      saturation,
    ),
    [keyframes, range.inSec, liveGains, saturation])

  const save = useCallback(async () => {
    setSaving(true)
    setSaveNote(null)
    const gains = Object.fromEntries(
      audioTracks.map(track => [track.id, liveGains[track.id] ?? 1]),
    ) as { game?: number; mic?: number; other?: number }
    const result = await window.flash?.saveClipEdit(clip.filePath, {
      startSeconds: range.inSec,
      endSeconds: range.outSec,
      gains,
      saturation,
      reEncode: saveMode.reason === 'audio' || saveMode.reason === 'video',
    })
    setSaving(false)
    if (!result || result.error) { setSaveNote(result?.error ?? 'Save failed'); return }
    // If smart render could not run, the native side falls back to a
    // keyframe-snapped cut. Say so rather than delivering a different clip than
    // the one on screen.
    const drift = result.actualStartSeconds !== undefined
      ? Math.abs(result.actualStartSeconds - range.inSec) : 0
    setSaveNote(drift > 0.05
      ? `Saved from ${formatTimecode(result.actualStartSeconds!)} — ${drift.toFixed(1)}s earlier than asked`
      : 'Saved alongside the original')
  }, [audioTracks, liveGains, saturation, saveMode, clip.filePath, range])

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

      <div className="flex-1 flex flex-col items-center gap-3 px-6 py-4 overflow-hidden min-h-0" aria-busy={audioTracks.length > 0 && !mixReady}>
        {/* The preview takes whatever the strip, mixer and footer leave, so it
            grows with the window instead of leaving a band of dead space. */}
        <div className="flex-1 w-full flex items-center justify-center min-h-0">
        <video
          ref={videoRef}
          key={clip.filePath}
          src={source}
          muted
          className="rounded-xl"
          style={{
            maxWidth: '100%', maxHeight: '100%', height: '100%', objectFit: 'contain', background: '#000',
            // Omitted entirely at 100 rather than set to saturate(100%), so the
            // ordinary case costs the compositor nothing.
            filter: saturation === 100 ? undefined : `saturate(${saturation}%)`,
          }}
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
        </div>

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

        {/* A picture control, so it sits above the sound controls rather than
            among them - but on the same grid, so the stack reads as one. */}
        <div className="w-full overflow-hidden rounded-lg" style={{ maxWidth: 900, background: 'var(--panel)', border: '1px solid var(--edge-soft)' }}>
          <div className="grid items-center gap-3 px-3" style={{ gridTemplateColumns: '32px 54px minmax(80px, 1fr) 112px 42px', minHeight: 48 }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-md"
              style={{ color: 'var(--spark)', background: 'var(--field)', border: '1px solid var(--edge-soft)' }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 1.8s4.2 4 4.2 6.7A4.2 4.2 0 018 12.7 4.2 4.2 0 013.8 8.5C3.8 5.8 8 1.8 8 1.8z" />
                <path d="M8 1.8v10.9" />
              </svg>
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              colour
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>
              {saturation === 100 ? 'unchanged' : 'saved copy re-encodes every frame'}
            </span>
            <input
              className="audio-gain-range"
              type="range"
              min={0}
              max={200}
              step={1}
              value={saturation}
              aria-label="Saturation"
              title="Double-click to reset"
              onDoubleClick={() => setSaturation(100)}
              onChange={event => setSaturation(event.currentTarget.valueAsNumber)}
            />
            <span style={{ fontSize: 11, color: 'var(--muted-2)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {saturation}%
            </span>
          </div>
        </div>

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
        {/* Honest about what the save will cost, and specific about which
            change caused it, rather than just going dark. */}
        <span style={{ fontSize: 11, color: saveMode.lossless ? 'var(--accent)' : 'var(--muted-3)' }}>
          {SAVE_NOTES[saveMode.reason]}
        </span>
        {saveNote && <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>{saveNote}</span>}
        <span className="ml-auto">
          <button
            disabled={saving || !(range.outSec > range.inSec)}
            onClick={save}
            className="px-4 py-1.5 rounded-md text-xs transition-all hover:brightness-110"
            style={{
              fontWeight: 600,
              color: 'var(--on-accent)',
              background: 'var(--accent)',
              opacity: saving || !(range.outSec > range.inSec) ? 0.5 : 1,
              cursor: saving ? 'default' : 'pointer',
            }}>
            {saving ? 'Saving…' : 'Save a copy'}
          </button>
        </span>
      </div>
    </div>
  )
}
