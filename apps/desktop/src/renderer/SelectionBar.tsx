import { useEffect, useState, type DragEvent } from 'react'
import { Dropdown } from './Dropdown'

export interface SelectionItem {
  id: string
  filePath: string
  game: string
  kind?: 'clip' | 'shot'
}

// Discord's upload ceilings. The tier is the hint rather than part of the
// label, so the size stays the thing you read first.
export const EXPORT_LIMITS = [
  { value: 10 * 1048576, label: '10MB', hint: 'Discord free' },
  { value: 50 * 1048576, label: '50MB', hint: 'Nitro Basic' },
  { value: 500 * 1048576, label: '500MB', hint: 'Nitro' },
]

export function SelectionBar({ items, games, onClear, onDelete, onRefresh }: {
  items: readonly SelectionItem[]
  games: readonly string[]
  onClear: () => void
  onDelete: () => void
  onRefresh: () => Promise<void>
}) {
  const [exportBytes, setExportBytes] = useState(10 * 1048576)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [targetGame, setTargetGame] = useState(games[0] ?? '')
  const [note, setNote] = useState<string | null>(null)
  const busy = exportBusy || moveBusy

  useEffect(() => {
    if (!games.includes(targetGame)) setTargetGame(games[0] ?? '')
  }, [games, targetGame])

  const startDrag = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    window.flash?.startClipDrag(items.map(item => item.filePath))
  }

  const exportSelected = async () => {
    const exportable = items.filter(clip => clip.kind !== 'shot')
    const skipped = items.length - exportable.length
    let exported = 0
    let failed = 0
    setExportBusy(true)
    setExportOpen(false)
    setNote(`Exporting 0/${items.length}`)

    for (const clip of exportable) {
      try {
        const result = await window.flash?.exportClip(clip.filePath, exportBytes)
        if (!result || result.error) failed++
        else exported++
      } catch {
        failed++
      }
      setNote(`Exporting ${exported + failed}/${items.length}`)
    }

    const skippedNote = skipped ? ` — ${skipped} screenshot${skipped === 1 ? '' : 's'} skipped` : ''
    const failedNote = failed ? ` — ${failed} failed` : ''
    setNote(`Exported ${exported} of ${items.length}${skippedNote}${failedNote}`)
    setExportBusy(false)
  }

  const moveSelected = async () => {
    if (!targetGame || !window.flash) return
    setMoveBusy(true)
    setNote(`Moving 0/${items.length}`)
    try {
      const result = await window.flash.moveClips(items.map(item => item.filePath), targetGame)
      await onRefresh()
      setMoveOpen(false)
      if (result.error) setNote(`Moved ${result.moved} of ${items.length} — ${result.error}`)
      else onClear()
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Move failed')
    } finally {
      setMoveBusy(false)
    }
  }

  const pickerLift = Math.min(games.length * 28 + 18, 320)

  return (
    <div
      draggable={!busy}
      onDragStart={startDrag}
      title="Drag the selected files into Discord"
      className="absolute flex items-center gap-2 rounded-xl"
      style={{
        left: 16, right: 16, bottom: 16, zIndex: 40, width: 'max-content', maxWidth: 'calc(100% - 32px)',
        margin: '0 auto', padding: '9px 10px', cursor: busy ? 'default' : 'grab',
        color: 'var(--fg)', background: 'var(--panel)', border: '1px solid var(--accent-line)',
        boxShadow: '0 12px 34px rgba(0,0,0,0.62)', animation: 'dialog-in 0.16s ease-out',
      }}>
      <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', padding: '0 4px' }}>
        {items.length} selected
      </span>
      <button type="button" onClick={onClear} disabled={busy}
        className="px-2 py-1 rounded-md text-xs transition-all hover:bg-white/5"
        style={{ color: 'var(--muted-2)', opacity: busy ? 0.5 : 1 }}>
        Clear
      </button>
      <div style={{ width: 1, height: 22, background: 'var(--edge-soft)' }} />
      <button type="button" onClick={onDelete} disabled={busy}
        className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-red-500/10"
        style={{ color: 'var(--alert)', border: '1px solid var(--accent-line)', opacity: busy ? 0.5 : 1 }}>
        Delete
      </button>
      <span className="flex items-center gap-1.5 px-2" style={{ fontSize: 11, color: 'var(--muted-2)' }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 4h8M2 8h8M4 2v8M8 2v8" stroke="currentColor" strokeWidth="1" opacity="0.65"/>
        </svg>
        Drag to Discord
      </span>
      <div className="relative">
        <button type="button" onClick={() => { setMoveOpen(false); setExportOpen(open => !open) }} disabled={busy}
          className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5"
          style={{ color: 'var(--muted-2)', border: '1px solid var(--edge-soft)', opacity: busy ? 0.5 : 1 }}>
          {exportBusy ? 'Exporting…' : 'Export to size'}
        </button>
        {exportOpen && (
          <div className="absolute flex items-center gap-2 rounded-lg"
            style={{
              right: 0, bottom: `calc(100% + ${EXPORT_LIMITS.length * 28 + 18}px)`, padding: 8,
              background: 'var(--panel)', border: '1px solid var(--edge)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
            }}>
            <Dropdown
              value={exportBytes}
              onChange={setExportBytes}
              title="Upload limit to fit under"
              options={EXPORT_LIMITS}
              width={150}
            />
            <button type="button" onClick={exportSelected}
              className="px-3 py-1.5 rounded-md text-xs transition-all hover:brightness-110"
              style={{ color: 'var(--on-accent)', background: 'var(--accent)' }}>
              Export
            </button>
          </div>
        )}
      </div>
      <div className="relative">
        <button type="button" onClick={() => { setExportOpen(false); setMoveOpen(open => !open) }} disabled={busy || games.length === 0}
          className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5"
          style={{ color: 'var(--muted-2)', border: '1px solid var(--edge-soft)', opacity: busy || games.length === 0 ? 0.5 : 1 }}>
          {moveBusy ? 'Moving…' : 'Move to game'}
        </button>
        {moveOpen && targetGame && (
          <div className="absolute flex items-center gap-2 rounded-lg"
            style={{
              right: 0, bottom: `calc(100% + ${pickerLift}px)`, padding: 8,
              background: 'var(--panel)', border: '1px solid var(--edge)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
            }}>
            <Dropdown
              value={targetGame}
              onChange={setTargetGame}
              title="Target game"
              options={games.map(game => ({ value: game, label: game }))}
              width={180}
            />
            <button type="button" onClick={moveSelected}
              className="px-3 py-1.5 rounded-md text-xs transition-all hover:brightness-110"
              style={{ color: 'var(--on-accent)', background: 'var(--accent)' }}>
              Move
            </button>
          </div>
        )}
      </div>
      {note && (
        <span role="status" style={{ fontSize: 11, color: 'var(--muted-2)', whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {note}
        </span>
      )}
    </div>
  )
}
