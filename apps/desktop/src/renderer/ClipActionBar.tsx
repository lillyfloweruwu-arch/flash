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
    <div className="flex items-center justify-between gap-4 shrink-0 titlebar-drag" style={{ height: 56, padding: '0 20px', borderBottom: '1px solid var(--edge-soft)' }}>
      <div className="flex items-center gap-4 min-w-0 titlebar-no-drag">
        <button onClick={onClose} className="btn btn-sm btn-ghost" style={{ paddingLeft: 6 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.5 6l-6 6 6 6" />
          </svg>
          {backLabel}
        </button>
        {middle}
      </div>

      <div className="flex items-center gap-2 shrink-0 titlebar-no-drag">
        <button
          draggable
          onDragStart={e => { e.preventDefault(); window.flash?.startClipDrag(filePath) }}
          onClick={async () => {
            const ok = await window.flash?.copyClipFile(filePath)
            setCopied(ok ? 'Copied' : 'Copy failed')
            setTimeout(() => setCopied(null), 1600)
          }}
          title="Click to copy the file, or drag this straight into Discord"
          className="btn btn-sm" style={{ cursor: 'grab' }}>
          {copied ?? 'Copy / drag'}
        </button>
        <button onClick={() => window.flash?.showClipInFolder(filePath)} className="btn btn-sm">
          Show in folder
        </button>
        {onDelete && (
          <button onClick={onDelete} className="btn btn-sm btn-danger">
            Delete
          </button>
        )}
      </div>
    </div>
  )
}
