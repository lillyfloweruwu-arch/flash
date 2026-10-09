import { useEffect, useMemo, useRef, useState } from 'react'
import { clipUrl } from '../shared/editor'
import { clipDisplayTitle } from '../shared/clipTitle'
import { type Clip, Icon, formatBytes } from './ui'

export type SortOrder = 'Recent' | 'Longest' | 'Largest'

export function sortClips(clips: Clip[], sort: SortOrder): Clip[] {
  return [...clips].sort((a, b) => {
    if (sort === 'Longest') return b.durationSec - a.durationSec
    if (sort === 'Largest') return b.size - a.size
    return b.createdAt - a.createdAt
  })
}

// The overview: every clip as an edge-to-edge tile, filters in one strip
// above. The feed is where clips are watched; this is where they are found,
// sorted and handled in bulk.
export function LibraryView({ clips, games, gameFilter, setGameFilter, starredOnly, setStarredOnly, starredCount,
  sort, setSort, query, onQueryChange, storage, onOpenFolder, shortcutsEnabled, selectedIds, onToggleSelection,
  onSelectRange, onSelectAll, onClearSelection, onOpenClip, onDeleteClip, onStarClip, suspendThumbnails, emptyHint }: {
  clips: Clip[]
  games: { name: string; count: number }[]
  gameFilter: string
  setGameFilter: (game: string) => void
  starredOnly: boolean
  setStarredOnly: (on: boolean) => void
  starredCount: number
  sort: SortOrder
  setSort: (sort: SortOrder) => void
  query: string
  onQueryChange: (query: string) => void
  storage: { used: number; clips: number }
  onOpenFolder: () => void
  shortcutsEnabled: boolean
  selectedIds: ReadonlySet<string>
  onToggleSelection: (id: string) => void
  onSelectRange: (displayedIds: readonly string[], targetId: string) => void
  onSelectAll: (displayedIds: readonly string[]) => void
  onClearSelection: () => void
  onOpenClip: (clip: Clip) => void
  onDeleteClip: (clip: Clip) => void
  onStarClip: (clip: Clip) => void
  suspendThumbnails: boolean
  emptyHint: React.ReactNode
}) {
  const searchRef = useRef<HTMLInputElement>(null)
  const displayedIds = useMemo(() => clips.map(clip => clip.id), [clips])
  // Newest-first reads as a diary, so it is broken into days under big date
  // headings; the other orders are rankings and stay one continuous wall.
  const groups = useMemo(() => sort === 'Recent' ? groupByDay(clips) : [{ key: 'all', clips }] as ClipGroup[], [clips, sort])

  useEffect(() => {
    if (!shortcutsEnabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const textInput = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      if (textInput) return

      if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        onSelectAll(displayedIds)
      } else if (event.key === 'Escape' && selectedIds.size > 0) {
        event.preventDefault()
        onClearSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [displayedIds, onClearSelection, onSelectAll, selectedIds.size, shortcutsEnabled])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Filter strip: what you are looking at on the left, how it is ordered on the right. */}
      <div className="flex items-center gap-6 shrink-0" style={{ height: 56, padding: '0 24px', borderBottom: '1px solid var(--edge-soft)' }}>
        <div className="flex items-center gap-5 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {games.length === 0 ? (
            <span className="caps" style={{ color: 'var(--muted-3)' }}>No games yet</span>
          ) : games.map(game => (
            <button key={game.name} className="tab" aria-pressed={gameFilter === game.name}
              onClick={() => setGameFilter(game.name)}>
              {game.name} <span className="count">{game.count}</span>
            </button>
          ))}
          <span aria-hidden="true" style={{ width: 1, height: 16, background: 'var(--edge)', flexShrink: 0 }} />
          <button className="tab" aria-pressed={starredOnly} onClick={() => setStarredOnly(!starredOnly)}
            style={{ alignItems: 'center' }}>
            <span style={{ display: 'flex', color: starredOnly ? 'var(--accent)' : 'inherit' }}>
              <Icon name="star" size={13} filled={starredOnly} strokeWidth={2} />
            </span>
            Starred <span className="count">{starredCount}</span>
          </button>
        </div>

        <div className="ml-auto flex items-center gap-5 shrink-0">
          <div className="flex items-center gap-4" role="group" aria-label="Sort clips">
            {(['Recent', 'Longest', 'Largest'] as const).map(order => (
              <button key={order} className="tab" aria-pressed={sort === order} onClick={() => setSort(order)}>
                {order}
              </button>
            ))}
          </div>
          <label className="relative flex items-center" style={{ color: 'var(--muted-3)' }}>
            <span className="absolute" style={{ left: 10, display: 'flex', pointerEvents: 'none' }}>
              <Icon name="search" size={14} />
            </span>
            <input
              ref={searchRef}
              type="text"
              aria-label="Search clips"
              placeholder="Search   /"
              value={query}
              onChange={event => onQueryChange(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                onQueryChange('')
                event.currentTarget.blur()
              }}
              className="field"
              style={{ width: 180, paddingLeft: 32, height: 32 }}
            />
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {clips.length === 0 ? (
          <div className="flex flex-col items-start justify-end" style={{ minHeight: 360, padding: '48px 24px' }}>
            <h1 className="display" style={{ fontSize: 64, color: 'var(--fg)' }}>
              {query || starredOnly || gameFilter !== 'All' ? 'Nothing matches' : 'No clips yet'}
            </h1>
            <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: 14, maxWidth: 520, lineHeight: 1.6 }}>
              {query || starredOnly || gameFilter !== 'All' ? (
                <button className="btn" style={{ marginTop: 6 }} onClick={() => {
                  onQueryChange(''); setStarredOnly(false); setGameFilter('All')
                }}>Clear filters</button>
              ) : emptyHint}
            </div>
          </div>
        ) : (
          groups.map(group => (
            <section key={group.key} aria-label={group.label ?? 'Clips'}>
              {group.label && (
                <header className="flex items-baseline gap-4" style={{ padding: '36px 24px 14px' }}>
                  <h2 className="display" style={{ fontSize: 56, color: 'var(--fg)' }}>{group.label}</h2>
                  <span className="caps" style={{ color: 'var(--muted)' }}>{group.weekday}</span>
                  <span className="tabular" style={{ fontSize: 12, color: 'var(--muted-3)' }}>
                    {group.clips.length} clip{group.clips.length === 1 ? '' : 's'}
                  </span>
                </header>
              )}
              <div className="grid" style={{ gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                {group.clips.map(clip => (
                  <ClipTile
                    key={clip.id}
                    clip={clip}
                    heading={group.label ? tileHeading(clip) : clipDisplayTitle(clip.title)}
                    selected={selectedIds.has(clip.id)}
                    onClick={event => {
                      if (event.shiftKey) {
                        event.preventDefault()
                        onSelectRange(displayedIds, clip.id)
                      } else if (event.ctrlKey || event.metaKey) {
                        event.preventDefault()
                        onToggleSelection(clip.id)
                      } else onOpenClip(clip)
                    }}
                    onToggle={() => onToggleSelection(clip.id)}
                    onDelete={() => onDeleteClip(clip)}
                    onStar={() => onStarClip(clip)}
                    suspend={suspendThumbnails}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        <footer className="flex items-center justify-between" style={{ padding: '18px 24px 28px', color: 'var(--muted-3)', fontSize: 12 }}>
          <span className="tabular">
            {clips.length} shown <span style={{ margin: '0 8px' }}>·</span>
            {storage.clips} on disk <span style={{ margin: '0 8px' }}>·</span>
            {formatBytes(storage.used)}
          </span>
          <button onClick={onOpenFolder} className="btn btn-sm">
            <Icon name="folder" size={14} /> Open clips folder
          </button>
        </footer>
      </div>
    </div>
  )
}

interface ClipGroup { key: string; label?: string; weekday?: string; clips: Clip[] }

function groupByDay(clips: Clip[]): ClipGroup[] {
  const groups: ClipGroup[] = []
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  for (const clip of clips) {
    const date = new Date(clip.createdAt)
    const key = date.toDateString()
    let group = groups[groups.length - 1]
    if (!group || group.key !== key) {
      const label = key === today.toDateString() ? 'Today'
        : key === yesterday.toDateString() ? 'Yesterday'
        : date.toLocaleDateString(undefined, {
          day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
        })
      group = { key, label, weekday: date.toLocaleDateString(undefined, { weekday: 'long' }), clips: [] }
      groups.push(group)
    }
    group.clips.push(clip)
  }
  return groups
}

// Under a day heading the date is already said, so an unrenamed clip shows
// just its time; a clip someone named keeps its name.
function tileHeading(clip: Clip): string {
  const display = clipDisplayTitle(clip.title)
  if (display === clip.title) return display
  return new Date(clip.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function ClipTile({ clip, heading, selected, onClick, onToggle, onDelete, onStar, suspend }: {
  clip: Clip
  heading: string
  selected: boolean
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void
  onToggle: () => void
  onDelete: () => void
  onStar: () => void
  suspend: boolean
}) {
  const [visible, setVisible] = useState(false)
  const tileRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Each thumbnail is a real <video> decoding a frame off disk. Mounting one per
  // clip means a library of 200 spins up 200 decoders at once, so hold the src
  // back until the tile is actually near the viewport - and give it back once
  // it leaves. Chromium caps concurrent decodes and paints the excess black.
  useEffect(() => {
    const node = tileRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '300px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Hovering a tile plays it, silently, the way a feed previews. Leaving puts
  // it back on the poster frame.
  const preview = (on: boolean) => {
    const video = videoRef.current
    if (!video) return
    if (on) video.play().catch(() => { /* not loaded yet */ })
    else { video.pause(); video.currentTime = 0.5 }
  }

  return (
    <div ref={tileRef}
      role="button"
      tabIndex={0}
      aria-label={`${clipDisplayTitle(clip.title)}, ${clip.game}${clip.kind === 'shot' ? ', screenshot' : `, ${clip.duration}`}`}
      data-selected={selected}
      // Native OS drag: drop the tile straight into Discord. preventDefault stops
      // Chromium starting its own (useless) HTML drag first.
      draggable
      onDragStart={e => { e.preventDefault(); window.flash?.startClipDrag(clip.filePath) }}
      className="tile"
      onMouseEnter={() => preview(true)}
      onMouseLeave={() => preview(false)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter') onClick(event as unknown as React.MouseEvent<HTMLDivElement>)
        if (event.key === ' ') { event.preventDefault(); onToggle() }
      }}
      onClick={onClick}>
      {/* Tiles behind the editor stay in the viewport, so without `suspend`
          their decoders stay alive underneath and the editor runs out. */}
      {clip.kind === 'shot' ? (
        <img src={clipUrl(clip.filePath)} alt="" loading="lazy" draggable={false}
          className="absolute inset-0 w-full h-full object-cover" style={{ pointerEvents: 'none' }} />
      ) : visible && !suspend && (
        <video ref={videoRef} src={`${clipUrl(clip.filePath)}#t=0.5`} preload="metadata" muted loop
          className="absolute inset-0 w-full h-full object-cover" style={{ pointerEvents: 'none' }} />
      )}
      <div className="tile-scrim" />

      <div className="absolute flex flex-col" style={{ left: 14, right: 14, bottom: 12, pointerEvents: 'none' }}>
        <span className="display truncate" style={{ fontSize: 24, color: 'var(--fg)' }}>{heading}</span>
        <span className="flex items-center gap-2 tabular" style={{ fontSize: 11, color: 'color-mix(in srgb, var(--fg) 72%, transparent)', marginTop: 5 }}>
          <span className="caps truncate" style={{ fontSize: 10 }}>{clip.game}</span>
          <span aria-hidden="true">·</span>
          {clip.kind === 'shot'
            ? <span className="flex items-center gap-1"><Icon name="image" size={12} /> Screenshot</span>
            : <span>{clip.duration}</span>}
        </span>
      </div>

      {/* Starred stays visible while scanning; the rest appear on hover, focus or selection. */}
      {clip.starred && (
        <span className="absolute tile-glyph tile-static" data-on="true" aria-hidden="true"
          style={{ top: 10, right: 10, pointerEvents: 'none' }}>
          <Icon name="star" size={15} filled strokeWidth={1.8} />
        </span>
      )}
      <div className="tile-tools absolute flex items-center gap-1.5" style={{ top: 10, right: 10 }}>
        <button className="tile-glyph" data-on={clip.starred}
          onClick={e => { e.stopPropagation(); onStar() }}
          title={clip.starred ? 'Starred: kept when old clips are deleted' : 'Star this clip to keep it'}
          aria-label={clip.starred ? `Unstar ${clip.title}` : `Star ${clip.title}`}>
          <Icon name="star" size={15} filled={clip.starred} strokeWidth={1.8} />
        </button>
        <button className="tile-glyph danger" onClick={e => { e.stopPropagation(); onDelete() }}
          title="Delete" aria-label={`Delete ${clip.title}`}>
          <Icon name="trash" size={15} strokeWidth={1.8} />
        </button>
      </div>
      <button className="tile-tools absolute tile-glyph"
        role="checkbox" aria-checked={selected}
        aria-label={`${selected ? 'Deselect' : 'Select'} ${clip.title}`}
        onClick={event => { event.stopPropagation(); onToggle() }}
        style={{
          top: 10, left: 10, borderRadius: 6,
          background: selected ? 'var(--accent)' : 'rgba(0,0,0,0.55)',
          color: selected ? 'var(--on-accent)' : 'var(--fg)',
          border: selected ? 'none' : '1.5px solid color-mix(in srgb, var(--fg) 70%, transparent)',
          width: 22, height: 22,
        }}>
        {selected && <Icon name="check" size={14} strokeWidth={2.6} />}
      </button>
    </div>
  )
}
