import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clipUrl, formatTimecode } from '../shared/editor'
import { clipDisplayTitle } from '../shared/clipTitle'
import { Dropdown } from './Dropdown'
import { DEFAULT_EXPORT_LIMIT, EXPORT_LIMITS, codecNote, findExportLimit } from '../shared/exportLimits'
import { useClipAudio } from './editor/useClipAudio'
import { useLiveMix } from './editor/useLiveMix'
import { thumbnailFor, useThumbnail } from './thumbnails'
import { usePlaybackVisibility } from './usePlaybackVisibility'
import { type Clip, GameMark, Icon, RenameTitle, formatBytes, timeAgo } from './ui'

// The home screen. One clip owns the whole window; the next one is a single
// flick away (wheel, arrow keys, J/K). The interface is white glyphs over a
// soft bottom scrim, and the theme accent appears only on live state.

export function FeedView({ clips, currentPath, onPathChange, filterLabel, onOpenLibrary, onClearFilters, filtered,
  onDelete, onEdit, onRename, onStar, isRecording, captureAvailable, hotkey, bufferLength, onToggleRecording }: {
  clips: Clip[]
  currentPath: string
  onPathChange: (path: string) => void
  filterLabel: string
  onOpenLibrary: () => void
  onClearFilters: () => void
  filtered: boolean
  onDelete: (clip: Clip) => void
  onEdit: (clip: Clip) => void
  onRename: (clip: Clip, name: string) => Promise<string | null>
  onStar: (clip: Clip) => void
  isRecording: boolean
  captureAvailable: boolean
  hotkey: string
  bufferLength: number
  onToggleRecording: () => void
}) {
  // Which clip is showing is remembered by file, not by row number. The list
  // re-scans underneath - a rename, a save landing, a filter narrowing - and a
  // stored index quietly slides onto a different clip. If the file vanishes,
  // hold the position it had rather than jumping to the top.
  const visible = usePlaybackVisibility()
  const lastIndex = useRef(0)
  const found = clips.findIndex(entry => entry.filePath === currentPath)
  const index = clips.length === 0 ? -1
    : found >= 0 ? found : Math.min(Math.max(lastIndex.current, 0), clips.length - 1)
  if (index >= 0) lastIndex.current = index
  const clip = index >= 0 ? clips[index] : undefined
  const isShot = clip?.kind === 'shot'
  const currentPathRef = useRef(clip?.filePath)
  currentPathRef.current = clip?.filePath

  const [direction, setDirection] = useState<'up' | 'down' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [frameBusy, setFrameBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportLimit, setExportLimit] = useState(DEFAULT_EXPORT_LIMIT)

  useEffect(() => {
    if (clip && clip.filePath !== currentPath) onPathChange(clip.filePath)
  }, [clip, currentPath, onPathChange])

  // The still shows on the first frame while the clip itself opens, so a flick
  // never lands on black. Neighbours are fetched ahead so the next flick is
  // covered too.
  const still = useThumbnail(clip?.filePath, clip?.kind)
  useEffect(() => {
    for (const neighbour of [clips[index + 1], clips[index - 1], clips[index + 2]]) {
      if (neighbour) void thumbnailFor(neighbour.filePath, neighbour.kind)
    }
  }, [clips, index])

  // A note describes the clip it was made on; moving on clears it.
  useEffect(() => { setNote(null); setCopied(null); setTime(0); setDuration(clip?.durationSec ?? 0) }, [clip?.filePath])

  // The element is muted and every track is mixed natively instead. A video
  // element plays only the FIRST audio track: a clip where the game was quiet
  // but you spoke has its voice on track two, and played as complete silence.
  const { tracks: audioTracks, error: audioError } = useClipAudio(clip && !isShot ? clip.filePath : '')
  const unityGains = useMemo(
    () => Object.fromEntries(audioTracks.map(track => [track.id, 1])),
    [audioTracks])
  useLiveMix(videoRef, audioTracks, unityGains, muted ? 0 : volume)

  // Close-to-tray and minimise pause every media element. The autoPlay
  // attribute does not restart one that was paused while it was hidden, so
  // play explicitly when the window comes back.
  useEffect(() => {
    if (!visible) return
    videoRef.current?.play().catch(() => { /* autoplay policy */ })
  }, [visible])

  const goTo = useCallback((target: number) => {
    if (index < 0) return
    const bounded = Math.max(0, Math.min(target, clips.length - 1))
    const next = clips[bounded]
    if (!next || bounded === index) return
    setDirection(bounded > index ? 'down' : 'up')
    onPathChange(next.filePath)
  }, [clips, index, onPathChange])
  const goNext = useCallback(() => goTo(index + 1), [goTo, index])
  const goPrev = useCallback(() => goTo(index - 1), [goTo, index])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => { /* autoplay policy */ })
    else video.pause()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowRight' || key === 'j') { event.preventDefault(); goNext() }
      else if (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'k') { event.preventDefault(); goPrev() }
      else if (key === 'Escape') onOpenLibrary()
      else if (key === ' ' && !(target instanceof HTMLButtonElement)) { event.preventDefault(); togglePlay() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, onOpenLibrary, togglePlay])

  // One wheel gesture moves one clip. A trackpad fires dozens of small deltas
  // per swipe, so they are summed and the feed then ignores input briefly
  // instead of skipping five clips at once.
  const wheel = useRef({ sum: 0, lockedUntil: 0 })
  const onWheel = (event: React.WheelEvent) => {
    const now = performance.now()
    const state = wheel.current
    if (now < state.lockedUntil) return
    state.sum += event.deltaY
    if (Math.abs(state.sum) < 60) return
    if (state.sum > 0) goNext(); else goPrev()
    state.sum = 0
    state.lockedUntil = now + 380
  }

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

  const grabFrame = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) { setNote('Frame is not ready'); return }
    setFrameBusy(true)
    setNote(null)
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
      setNote('Frame saved next to the clip')
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not grab frame')
    } finally {
      setFrameBusy(false)
    }
  }, [clip])

  // Capture stays archival-quality; this makes a small sibling that actually
  // fits an upload limit. It re-encodes, so it takes seconds.
  const exportCopy = async () => {
    if (!clip) return
    const startedPath = clip.filePath
    setExportBusy(true); setNote(null)
    const limit = findExportLimit(exportLimit)
    try {
      const result = await window.flash?.exportClip(clip.filePath, limit.bytes, limit.codec)
      if (currentPathRef.current !== startedPath) return
      if (!result || result.error) { setNote(result?.error ?? 'Export failed'); return }
      const fallback = codecNote(limit.codec, result.codec)
      setNote(`Shareable copy saved: ${formatBytes(result.bytes ?? 0)} at ${result.height}p${fallback ? `. ${fallback}` : ''}`)
    } catch (error) {
      if (currentPathRef.current === startedPath) {
        setNote(error instanceof Error ? error.message : 'Export failed')
      }
    } finally {
      setExportBusy(false)
    }
  }

  const copyFile = async () => {
    if (!clip) return
    const ok = await window.flash?.copyClipFile(clip.filePath)
    setCopied(ok ? 'Copied' : 'Failed')
    setTimeout(() => setCopied(null), 1600)
  }

  if (!clip) {
    return (
      <FeedEmpty filtered={filtered} filterLabel={filterLabel} onClearFilters={onClearFilters}
        isRecording={isRecording} captureAvailable={captureAvailable} hotkey={hotkey}
        bufferLength={bufferLength} onToggleRecording={onToggleRecording} />
    )
  }

  const progress = duration > 0 ? (time / duration) * 100 : 0
  const display = clipDisplayTitle(clip.title)
  const named = display === clip.title
  const parts = display.split(' · ')
  const heading = !named && parts.length === 2
    ? { main: parts[0], sub: parts[1] }
    : { main: display, sub: new Date(clip.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) }

  return (
    <section aria-label="Clip feed" className="absolute inset-0 overflow-hidden select-none" style={{ background: '#000' }}
      onWheel={onWheel}>
      <div key={clip.filePath} className="feed-media absolute inset-0" data-dir={direction ?? undefined}>
        {isShot ? (
          <img src={clipUrl(clip.filePath)} alt={clip.title} draggable={false}
            className="absolute inset-0 w-full h-full" style={{ objectFit: 'contain' }} />
        ) : (
          <video
            ref={videoRef}
            crossOrigin="anonymous"
            poster={still ?? undefined}
            src={clipUrl(clip.filePath)}
            autoPlay={visible}
            muted
            loop
            className="absolute inset-0 w-full h-full"
            style={{ objectFit: 'contain' }}
            onLoadedMetadata={event => setDuration(event.currentTarget.duration || clip.durationSec || 0)}
            onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={togglePlay}
          />
        )}
      </div>

      {/* Scrims: the top one carries the title bar, the bottom one the caption. */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 pointer-events-none"
        style={{ height: 140, background: 'linear-gradient(to bottom, rgba(4,4,6,0.78), transparent)' }} />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{ height: '62%', background: 'linear-gradient(to top, rgba(4,4,6,0.95) 0%, var(--scrim) 22%, rgba(4,4,6,0.6) 48%, transparent 100%)' }} />

      {/* Only when the list is narrowed: which slice of the library this is. */}
      {filtered && (
        <div className="absolute flex items-center gap-3" style={{ top: 64, left: 48 }}>
          <span className="caps" style={{ color: 'var(--fg)', textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}>{filterLabel}</span>
          <button onClick={onClearFilters} className="btn btn-sm" style={{ background: 'rgba(0,0,0,0.35)' }}>Show all</button>
        </div>
      )}

      {/* Caption: the title as a stacked block, the actions, then the author
          line anchored at the foot - the reading order of a feed item. */}
      <div key={`caption-${clip.filePath}`} className="feed-caption absolute flex flex-col items-start"
        style={{ left: 48, right: 150, bottom: 64 }}>
        <RenameTitle title={clip.title} display={heading.main} onCommit={renameCurrent}
          className="display"
          style={{
            fontSize: heading.main.length > 14 ? 'clamp(48px, 9vh, 96px)' : 'clamp(64px, 17vh, 168px)',
            lineHeight: 0.86, color: 'var(--fg)', textShadow: '0 2px 30px rgba(0,0,0,0.45)',
          }} />
        <span className="tabular" style={{
          marginTop: 12, fontSize: 15, fontWeight: 500, letterSpacing: '0.42em', textTransform: 'uppercase',
          color: 'var(--fg)', textShadow: '0 1px 10px rgba(0,0,0,0.6)',
        }}>
          {heading.sub}
        </span>

        {!isShot && (
          <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 26 }}>
            <button onClick={() => onEdit(clip)} className="btn btn-solid">
              <Icon name="edit" size={15} /> Edit clip
            </button>
            <button onClick={grabFrame} disabled={frameBusy} className="btn">
              <Icon name="camera" size={15} /> {frameBusy ? 'Saving…' : 'Grab frame'}
            </button>
            <div className="flex items-center" style={{ gap: 0 }}>
              <button onClick={exportCopy} disabled={exportBusy} className="btn"
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                title={`Make a copy under ${Math.round(findExportLimit(exportLimit).bytes / 1048576)}MB to send in Discord`}>
                <Icon name="send" size={15} /> {exportBusy ? 'Compressing…' : 'Export'}
              </button>
              <Dropdown value={exportLimit} onChange={setExportLimit} title="Upload limit to fit under"
                options={EXPORT_LIMITS} width={150} variant="joined" />
            </div>
            {note && <span role="status" style={{ fontSize: 12, color: 'var(--fg)', marginLeft: 6, textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}>{note}</span>}
          </div>
        )}

        {!isShot && audioError && (
          <p role="alert" style={{ fontSize: 12, color: 'var(--alert)', marginTop: 8 }}>Audio unavailable</p>
        )}

        <div className="flex items-center gap-3" style={{ marginTop: 22 }}>
          <GameMark game={clip.game} size={34} />
          <div className="flex flex-col" style={{ gap: 3 }}>
            <span className="caps" style={{ color: 'var(--fg)', fontSize: 12 }}>{clip.game}</span>
            <span className="tabular" style={{ fontSize: 12, color: 'var(--fg)', opacity: 0.88 }}>
              {timeAgo(clip.createdAt)}
              <span style={{ margin: '0 7px' }}>·</span>
              {isShot ? 'Screenshot' : clip.duration}
              <span style={{ margin: '0 7px' }}>·</span>
              {formatBytes(clip.size)}
            </span>
          </div>
        </div>
      </div>

      {/* Action rail. */}
      <nav aria-label="Clip actions" className="absolute flex flex-col items-center"
        style={{ right: 28, top: '50%', transform: 'translateY(-50%)', gap: 10 }}>
        <button className="rail-btn" data-on={clip.starred} onClick={() => onStar(clip)}
          aria-pressed={clip.starred}
          title={clip.starred ? 'Starred: kept when old clips are deleted' : 'Star to keep this clip'}>
          <span key={clip.starred ? 'on' : 'off'} className={clip.starred ? 'star-pop' : undefined} style={{ display: 'flex' }}>
            <Icon name="star" size={30} filled={clip.starred} strokeWidth={1.4} />
          </span>
          <span>{clip.starred ? 'Starred' : 'Star'}</span>
        </button>
        <button className="rail-btn" onClick={copyFile}
          draggable onDragStart={event => { event.preventDefault(); window.flash?.startClipDrag(clip.filePath) }}
          title="Click to copy the file, or drag it straight into Discord" style={{ cursor: 'grab' }}>
          <Icon name="copy" size={30} strokeWidth={1.4} />
          <span>{copied ?? 'Copy'}</span>
        </button>
        <button className="rail-btn" onClick={() => window.flash?.showClipInFolder(clip.filePath)} title="Show in folder">
          <Icon name="folder" size={30} strokeWidth={1.4} />
          <span>Folder</span>
        </button>
        <button className="rail-btn danger" onClick={() => onDelete(clip)} title="Delete from disk">
          <Icon name="trash" size={30} strokeWidth={1.4} />
          <span>Delete</span>
        </button>

        <div aria-hidden="true" style={{ width: 1, height: 28, background: 'var(--line)', margin: '6px 0' }} />

        <button className="rail-btn" onClick={goPrev} disabled={index === 0} aria-label="Previous clip" title="Previous (↑ or K)">
          <Icon name="up" size={26} />
        </button>
        <div className="flex flex-col items-center" aria-live="polite">
          <span className="display" style={{ fontSize: 26, color: 'var(--fg)' }}>{index + 1}</span>
          <span className="tabular" style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.06em' }}>of {clips.length}</span>
        </div>
        <button className="rail-btn" onClick={goNext} disabled={index === clips.length - 1} aria-label="Next clip" title="Next (↓ or J)">
          <Icon name="down" size={26} />
        </button>
      </nav>

      {/* Transport along the bottom edge. */}
      {!isShot && (
        <div className="absolute flex items-center gap-3" style={{ left: 40, right: 40, bottom: 20 }}>
          <button onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}
            className="w-8 h-8 flex items-center justify-center rounded-md shrink-0" style={{ color: 'var(--fg)' }}>
            <Icon name={playing ? 'pause' : 'play'} size={18} />
          </button>
          <span className="tabular shrink-0" style={{ fontSize: 12, color: 'var(--fg)', minWidth: 44 }}>{formatTimecode(time)}</span>
          <input
            type="range"
            className="player-scrub"
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.05}
            value={Math.min(time, duration)}
            aria-label="Seek"
            onChange={event => {
              const seconds = event.currentTarget.valueAsNumber
              const video = videoRef.current
              if (video) video.currentTime = seconds
              setTime(seconds)
            }}
            style={{ flex: 1, ['--played' as string]: `${progress}%` }}
          />
          <span className="tabular shrink-0" style={{ fontSize: 12, color: 'var(--muted)', minWidth: 44, textAlign: 'right' }}>{formatTimecode(duration)}</span>
          <button onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}
            className="w-8 h-8 flex items-center justify-center rounded-md shrink-0" style={{ color: muted ? 'var(--muted-3)' : 'var(--fg)' }}>
            <Icon name={muted ? 'mute' : 'volume'} size={18} />
          </button>
          <input
            type="range"
            className="audio-gain-range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={event => { const next = event.currentTarget.valueAsNumber; setVolume(next); setMuted(next === 0) }}
            style={{ width: 84, ['--filled' as string]: `${(muted ? 0 : volume) * 100}%` }}
          />
        </div>
      )}
    </section>
  )
}

function FeedEmpty({ filtered, filterLabel, onClearFilters, isRecording, captureAvailable, hotkey, bufferLength, onToggleRecording }: {
  filtered: boolean
  filterLabel: string
  onClearFilters: () => void
  isRecording: boolean
  captureAvailable: boolean
  hotkey: string
  bufferLength: number
  onToggleRecording: () => void
}) {
  return (
    <section className="absolute inset-0 flex flex-col justify-end" style={{ padding: '0 48px 96px', background: 'radial-gradient(ellipse at 70% 30%, var(--panel), var(--bg) 70%)' }}>
      {filtered ? (
        <>
          <h1 className="display" style={{ fontSize: 84, color: 'var(--fg)' }}>Nothing here</h1>
          <p style={{ fontSize: 15, color: 'var(--muted)', marginTop: 16, maxWidth: 520, lineHeight: 1.6 }}>
            No clips match <span style={{ color: 'var(--fg)' }}>{filterLabel.toLowerCase()}</span>.
          </p>
          <div style={{ marginTop: 24 }}>
            <button onClick={onClearFilters} className="btn btn-solid">Show all clips</button>
          </div>
        </>
      ) : (
        <>
          <h1 className="display" style={{ fontSize: 96, color: 'var(--fg)' }}>No clips yet</h1>
          <p style={{ fontSize: 15, color: 'var(--muted)', marginTop: 16, maxWidth: 560, lineHeight: 1.6 }}>
            {!captureAvailable
              ? 'The capture engine is unavailable. Check that the native addon is built.'
              : isRecording
                ? <>Flash is holding the last {bufferLength} seconds. Press <span className="keycap" style={{ color: 'var(--fg)' }}>{hotkey}</span> in game and the moment lands here.</>
                : <>Start the replay buffer, then press <span className="keycap" style={{ color: 'var(--fg)' }}>{hotkey}</span> in game to keep the last {bufferLength} seconds.</>}
          </p>
          {captureAvailable && !isRecording && (
            <div style={{ marginTop: 24 }}>
              <button onClick={onToggleRecording} className="btn btn-solid">Start replay buffer</button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
