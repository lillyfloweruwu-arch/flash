import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipActionBar } from './ClipActionBar'
import { clipDisplayTitle } from '../shared/clipTitle'
import { AudioLanes } from './editor/AudioLanes'
import { Filmstrip, TRIM_SNAP_SEC } from './editor/Filmstrip'
import { useLiveMix } from './editor/useLiveMix'
import { useClipAudio } from './editor/useClipAudio'
import type { LiveMixTrack } from './editor/useLiveMix'
import { clampRange, clipUrl, deriveSaveMode, formatTimecode, nearestKeyframe } from '../shared/editor'
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
  const [grabbing, setGrabbing] = useState(false)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  // Decoding walks the whole file, so the lanes arrive seconds after the
  // screen. Showing nothing while that happens reads as broken rather than
  // busy, so the mixer renders placeholder rows until the tracks land.
  const { tracks: audioTracks, loading: audioLoading } = useClipAudio(clip.filePath)
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
    setGains({})
    setMutedTracks(new Set())
  }, [clip.filePath])

  useEffect(() => {
    // Hiding the app releases decoded samples, not the user's mix edits.
    // Reappearing tracks only need defaults for lanes we have not seen yet.
    if (!audioTracks.length) return
    setGains(current => ({ ...Object.fromEntries(audioTracks.map(track => [track.id, 1])), ...current }))
  }, [audioTracks])

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

  const grabFrame = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) {
      setSaveNote('Frame is not ready')
      return
    }

    setGrabbing(true)
    setSaveNote(null)
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
      const result = await window.flash?.saveClipFrame(
        clip.filePath, playheadSeconds, new Uint8Array(await blob.arrayBuffer()))
      if (!result || result.error) throw new Error(result?.error ?? 'Could not save screenshot')
      setSaveNote('Frame saved alongside the original')
    } catch (error) {
      setSaveNote(error instanceof Error ? error.message : 'Could not grab frame')
    } finally {
      setGrabbing(false)
    }
  }, [clip.filePath])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => { /* autoplay policy */ })
    else video.pause()
  }, [])

  const setTrimEdge = useCallback((edge: 'in' | 'out', seconds: number) => {
    const snapped = nearestKeyframe(keyframes, seconds, TRIM_SNAP_SEC) ?? seconds
    setRange(current => edge === 'in'
      ? clampRange(snapped, current.outSec, duration)
      : clampRange(current.inSec, snapped, duration))
  }, [duration, keyframes])

  // Escape closes, Space toggles play, and brackets set the trim edges. Left
  // and right deliberately do nothing here: they move between clips in the
  // player, and carrying that into the editor would let a stray keypress swap
  // the clip out from under an in-progress edit.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (event.key === 'Escape') onClose()
      if (event.code === 'Space') { event.preventDefault(); togglePlay() }
      if (event.key === '[' || event.key === ']') {
        const video = videoRef.current
        if (!video) return
        event.preventDefault()
        setTrimEdge(event.key === '[' ? 'in' : 'out', video.currentTime)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, setTrimEdge, togglePlay])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = speed
  }, [speed])

  const source = clipUrl(clip.filePath)

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bg)' }}>
      <ClipActionBar filePath={clip.filePath} onClose={onClose} backLabel="Back" middle={
        <span className="display truncate" style={{ fontSize: 24, color: 'var(--fg)' }}>{clipDisplayTitle(clip.title)}</span>
      } />

      <div className="flex-1 flex flex-col items-center gap-3 px-6 pt-3 pb-3 overflow-hidden min-h-0" aria-busy={audioTracks.length > 0 && !mixReady}>
        {/* The clip takes the room, the mixer sits beside it, and the strip
            runs the full width underneath, so the picture is the largest
            thing on the screen rather than a postcard above the controls. */}
        <div className="flex-1 w-full flex gap-6 min-h-0">
        {/* The preview takes whatever the strip, mixer and footer leave, so it
            grows with the window instead of leaving a band of dead space. */}
        <div className="flex-1 min-w-0 flex items-start justify-center min-h-0">
        <video
          ref={videoRef}
          crossOrigin="anonymous"
          key={clip.filePath}
          src={source}
          muted
          style={{
            maxWidth: '100%', maxHeight: '100%', height: '100%', objectFit: 'contain', borderRadius: 4,
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

          <div className="flex flex-col justify-start shrink-0 overflow-y-auto" style={{ width: 360 }}>
            <h2 className="display" style={{ fontSize: 30, color: "var(--fg)", paddingBottom: 12 }}>Mix</h2>
        {/* A picture control, so it sits above the sound controls rather than
            among them - but on the same grid, so the stack reads as one. */}
        <div className="w-full overflow-hidden" style={{ maxWidth: 900, borderTop: '1px solid var(--edge-soft)', borderBottom: '1px solid var(--edge-soft)' }}>
          <div className="grid items-center gap-3 px-3" style={{ gridTemplateColumns: '32px 54px minmax(60px, 1fr) 88px 42px', minHeight: 48 }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-md"
              style={{ color: 'var(--fg)', border: '1px solid var(--line)' }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 1.8s4.2 4 4.2 6.7A4.2 4.2 0 018 12.7 4.2 4.2 0 013.8 8.5C3.8 5.8 8 1.8 8 1.8z" />
                <path d="M8 1.8v10.9" />
              </svg>
            </span>
            <span className="caps" style={{ color: 'var(--fg)', fontSize: 10.5 }}>
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
              style={{ ['--filled' as string]: `${saturation / 2}%` }}
            />
            <span style={{ fontSize: 11, color: 'var(--muted-2)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {saturation}%
            </span>
          </div>
        </div>

        <AudioLanes
          loading={audioLoading}
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

          </div>
        </div>

        <div className="w-full">
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

        </div>

        <div className="w-full flex items-center gap-3">
          <button onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
            className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5"
            style={{ color: 'var(--fg)' }}>
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
          <span className="ml-auto flex items-center gap-4" role="group" aria-label="Preview speed">
            {SPEEDS.map(value => (
              <button key={value} onClick={() => setSpeed(value)}
                aria-pressed={speed === value}
                className="tab tabular">
                {value}x
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 px-6 shrink-0" style={{ height: 64, borderTop: '1px solid var(--edge-soft)' }}>
        <span className="display" style={{ fontSize: 26, color: 'var(--fg)' }}>
          {(range.outSec - range.inSec).toFixed(1)}s
        </span>
        <span className="tabular" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {formatTimecode(range.inSec)} → {formatTimecode(range.outSec)}
        </span>
        <span className="flex items-center gap-2" style={{ fontSize: 12, color: 'var(--muted-3)' }}>
          <span className="keycap">[</span> in <span className="keycap">]</span> out
        </span>
        {/* Honest about what the save will cost, and specific about which
            change caused it, rather than just going dark. */}
        <span style={{ fontSize: 12, color: saveMode.lossless ? 'var(--fg)' : 'var(--muted-3)' }}>
          {SAVE_NOTES[saveMode.reason]}
        </span>
        {saveNote && <span role="status" style={{ fontSize: 12, color: 'var(--muted)' }}>{saveNote}</span>}
        <span className="ml-auto flex items-center gap-2">
          {clip.kind !== 'shot' && (
            <button disabled={grabbing} onClick={grabFrame} className="btn shrink-0">
              {grabbing ? 'Saving…' : 'Grab frame'}
            </button>
          )}
          <button
            disabled={saving || !(range.outSec > range.inSec)}
            onClick={save}
            className="btn btn-solid">
            {saving ? 'Saving…' : 'Save a copy'}
          </button>
        </span>
      </div>
    </div>
  )
}
