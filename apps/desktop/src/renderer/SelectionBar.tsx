import { useEffect, useState, type DragEvent } from 'react'
import { Dropdown } from './Dropdown'
import { EXPORT_LIMITS, codecNote, defaultExportLimit, findExportLimit } from '../shared/exportLimits'

export interface SelectionItem {
  id: string
  filePath: string
  game: string
  kind?: 'clip' | 'shot'
}

export function SelectionBar({ items, games, onClear, onDelete, onRefresh }: {
  items: readonly SelectionItem[]
  games: readonly string[]
  onClear: () => void
  onDelete: () => void
  onRefresh: () => Promise<void>
}) {
  const [exportLimit, setExportLimit] = useState(() => defaultExportLimit(window.flash?.platform))
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
    const limit = findExportLimit(exportLimit)
    let fallback = ''
    setExportBusy(true)
    setExportOpen(false)
    setNote(`Exporting 0/${items.length}`)

    for (const clip of exportable) {
      try {
        const result = await window.flash?.exportClip(clip.filePath, limit.bytes, limit.codec)
        if (!result || result.error) failed++
        else { exported++; fallback = codecNote(limit.codec, result.codec) || fallback }
      } catch {
        failed++
      }
      setNote(`Exporting ${exported + failed}/${items.length}`)
    }

    const skippedNote = skipped ? ` — ${skipped} screenshot${skipped === 1 ? '' : 's'} skipped` : ''
    const failedNote = failed ? ` — ${failed} failed` : ''
    const codecSuffix = fallback ? ` — ${fallback}` : ''
    setNote(`Exported ${exported} of ${items.length}${skippedNote}${failedNote}${codecSuffix}`)
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

  return (
    <div
      draggable={!busy}
      onDragStart={startDrag}
      title="Drag the selected files into Discord"
      className="absolute flex items-center gap-2"
      style={{
        left: 16, right: 16, bottom: 20, zIndex: 40, width: 'max-content', maxWidth: 'calc(100% - 32px)',
        margin: '0 auto', padding: '10px 12px 10px 18px', cursor: busy ? 'default' : 'grab', borderRadius: 10,
        color: 'var(--fg)', background: 'var(--panel)', border: '1px solid var(--edge)',
        boxShadow: '0 16px 40px rgba(0,0,0,0.6)', animation: 'dialog-in 0.16s var(--ease-out)',
      }}>
      <span className="display" style={{ fontSize: 22, whiteSpace: 'nowrap', marginRight: 6 }}>
        {items.length} selected
      </span>
      <button type="button" onClick={onClear} disabled={busy} className="btn btn-sm btn-ghost">
        Clear
      </button>
      <div style={{ width: 1, height: 22, background: 'var(--edge)' }} />
      <button type="button" onClick={onDelete} disabled={busy} className="btn btn-sm btn-danger">
        Delete
      </button>
      <span className="flex items-center gap-1.5 px-2" style={{ fontSize: 12, color: 'var(--muted)' }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 4h8M2 8h8M4 2v8M8 2v8" stroke="currentColor" strokeWidth="1" opacity="0.65"/>
        </svg>
        Drag to Discord
      </span>
      <div className="relative">
        <button type="button" onClick={() => { setMoveOpen(false); setExportOpen(open => !open) }} disabled={busy}
          className="btn btn-sm" aria-expanded={exportOpen}>
          {exportBusy ? 'Exporting…' : 'Export to size'}
        </button>
        {exportOpen && (
          <div className="absolute flex items-center gap-2"
            style={{
              right: 0, bottom: 'calc(100% + 12px)', padding: 8, borderRadius: 8,
              background: 'var(--panel)', border: '1px solid var(--edge)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
            }}>
            <Dropdown
              value={exportLimit}
              onChange={setExportLimit}
              title="Upload limit to fit under"
              options={EXPORT_LIMITS}
              width={150}
            />
            <button type="button" onClick={exportSelected} className="btn btn-sm btn-solid">
              Export
            </button>
          </div>
        )}
      </div>
      <div className="relative">
        <button type="button" onClick={() => { setExportOpen(false); setMoveOpen(open => !open) }} disabled={busy || games.length === 0}
          className="btn btn-sm" aria-expanded={moveOpen}>
          {moveBusy ? 'Moving…' : 'Move to game'}
        </button>
        {moveOpen && targetGame && (
          <div className="absolute flex items-center gap-2"
            style={{
              right: 0, bottom: 'calc(100% + 12px)', padding: 8, borderRadius: 8,
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
            <button type="button" onClick={moveSelected} className="btn btn-sm btn-solid">
              Move
            </button>
          </div>
        )}
      </div>
      {note && (
        <span role="status" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {note}
        </span>
      )}
    </div>
  )
}
