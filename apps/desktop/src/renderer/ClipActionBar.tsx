import { useState } from 'react'

// The header shared by the clip player and the editor, so the two screens
// cannot drift apart. It takes a path rather than a clip: everything it does is
// per-file, and keeping it decoupled avoids a circular import between the two
// screens that both use it.
//
// `middle` is whatever belongs between Back and the actions - the clip counter
// in the player, the clip's name in the editor.
export function ClipActionBar({ filePath, onClose, onDelete, middle, backLabel = 'Back' }: {
  filePath: string
  onClose: () => void
  onDelete?: () => void
  middle?: React.ReactNode
  backLabel?: string
}) {
  const [copied, setCopied] = useState<string | null>(null)

  return (
    <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--edge-soft)' }}>
      <div className="flex items-center gap-3">
        <button onClick={onClose} className="flex items-center gap-1.5 text-sm transition-colors hover:text-white" style={{ color: 'var(--muted-2)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          {backLabel}
        </button>
        {middle != null && <div style={{ width: 1, height: 14, background: 'var(--edge-soft)' }} />}
        {middle}
      </div>

      <div className="flex items-center gap-2">
        <button
          draggable
          onDragStart={e => { e.preventDefault(); window.flash?.startClipDrag(filePath) }}
          onClick={async () => {
            const ok = await window.flash?.copyClipFile(filePath)
            setCopied(ok ? 'Copied' : 'Copy failed')
            setTimeout(() => setCopied(null), 1600)
          }}
          title="Click to copy the file, or drag this straight into Discord"
          className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5"
          style={{ color: copied ? 'var(--accent)' : 'var(--muted-2)', border: `1px solid ${copied ? 'var(--accent-line)' : 'var(--edge-soft)'}`, cursor: 'grab' }}>
          {copied ?? 'Copy / Drag'}
        </button>
        <button onClick={() => window.flash?.showClipInFolder(filePath)}
          className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-white/5"
          style={{ color: 'var(--muted-2)', border: '1px solid var(--edge-soft)' }}>
          Show in Folder
        </button>
        {onDelete && (
          <button onClick={onDelete}
            className="px-3 py-1.5 rounded-md text-xs transition-all hover:bg-red-500/10"
            style={{ color: 'var(--alert)', border: '1px solid var(--accent-line)' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} aria-label="Close"
          className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5"
          style={{ color: 'var(--muted-2)' }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
