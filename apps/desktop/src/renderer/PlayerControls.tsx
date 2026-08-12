import { formatTimecode } from '../shared/editor'

// Flash's own transport bar. The element it drives is muted and its audio goes
// through Web Audio, so Chromium's built-in controls would show a volume slider
// that moves nothing - and they bring a Picture-in-Picture and playback-speed
// menu nobody asked for.
export function PlayerControls({ playing, currentSec, durationSec, volume, muted, onTogglePlay, onSeek, onVolume, onToggleMute }: {
  playing: boolean
  currentSec: number
  durationSec: number
  volume: number
  muted: boolean
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  onVolume: (volume: number) => void
  onToggleMute: () => void
}) {
  const progress = durationSec > 0 ? (currentSec / durationSec) * 100 : 0

  return (
    <div className="w-full flex items-center gap-3 px-1" style={{ maxWidth: 900 }}>
      <button onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Play'}
        className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5 shrink-0"
        style={{ color: 'var(--accent)' }}>
        {playing
          ? <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="1" width="3.5" height="12" rx="1"/><rect x="8.5" y="1" width="3.5" height="12" rx="1"/></svg>
          : <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 1.8v10.4c0 .7.8 1.1 1.4.7l8-5.2a.85.85 0 000-1.4l-8-5.2c-.6-.4-1.4 0-1.4.7z"/></svg>}
      </button>

      <span style={{ fontSize: 12, color: 'var(--muted-2)', fontVariantNumeric: 'tabular-nums' }}>
        {formatTimecode(currentSec)}
      </span>

      {/* A range input rather than a styled div: it carries keyboard seeking
          and a screen-reader value for free. */}
      <input
        type="range"
        className="player-scrub"
        min={0}
        max={Math.max(durationSec, 0.1)}
        step={0.05}
        value={Math.min(currentSec, durationSec)}
        aria-label="Seek"
        onChange={event => onSeek(event.currentTarget.valueAsNumber)}
        style={{ flex: 1, ['--played' as string]: `${progress}%` }}
      />

      <span style={{ fontSize: 12, color: 'var(--muted-3)', fontVariantNumeric: 'tabular-nums' }}>
        {formatTimecode(durationSec)}
      </span>

      <button onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}
        className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5 shrink-0"
        style={{ color: muted ? 'var(--muted-3)' : 'var(--muted)' }}>
        {muted
          ? <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M8 2.5L4.5 5.5H2v5h2.5L8 13.5z"/><path d="M11 6l3.5 4M14.5 6L11 10"/></svg>
          : <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M8 2.5L4.5 5.5H2v5h2.5L8 13.5z"/><path d="M10.8 5.8a3 3 0 010 4.4M12.8 3.8a6 6 0 010 8.4"/></svg>}
      </button>

      <input
        type="range"
        className="audio-gain-range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        aria-label="Volume"
        onChange={event => onVolume(event.currentTarget.valueAsNumber)}
        style={{ width: 84 }}
      />
    </div>
  )
}
