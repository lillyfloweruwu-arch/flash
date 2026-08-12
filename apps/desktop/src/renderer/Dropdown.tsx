import { useEffect, useRef, useState } from 'react'

export type DropdownOption<T> = { value: T; label: string; hint?: string }

// A select that looks like Flash rather than like Windows.
//
// The native control cannot be styled past its border: the popup is drawn by
// the OS, in the OS's colours, at the OS's font size. This draws its own, and
// keeps the keyboard behaviour the native one gives away for free - arrows to
// move, Enter to choose, Escape to cancel, Home and End to jump - because a
// dropdown that only works with a mouse is worse than an ugly one.
export function Dropdown<T extends string | number>({ value, options, onChange, title, width = 168 }: {
  value: T
  options: DropdownOption<T>[]
  onChange: (value: T) => void
  title?: string
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture phase: the clip player and editor both listen for Escape and
    // would close underneath this popup otherwise.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, options, value])

  const choose = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
  }

  const onButtonKey = (event: React.KeyboardEvent) => {
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); setOpen(true); return
    }
    if (!open) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(i + 1, options.length - 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1) }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
  }

  return (
    <div ref={rootRef} className="relative shrink-0" style={{ width }}>
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKey}
        className="w-full flex items-center gap-2 rounded-md transition-all hover:bg-white/5"
        style={{
          fontSize: 11, color: 'var(--muted-2)', background: 'var(--field)',
          border: `1px solid ${open ? 'var(--accent-line)' : 'var(--edge)'}`,
          padding: '4px 8px', textAlign: 'left',
        }}>
        <span className="flex-1 truncate">{selected?.label}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms ease', flexShrink: 0 }}>
          <path d="M2 3.5L5 6.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div role="listbox" aria-activedescendant={`dropdown-option-${active}`}
          className="absolute z-50 rounded-md overflow-hidden"
          style={{
            top: 'calc(100% + 4px)', left: 0, width: '100%',
            background: 'var(--panel)', border: '1px solid var(--edge)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
          }}>
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
              <button
                key={String(option.value)}
                id={`dropdown-option-${index}`}
                role="option"
                aria-selected={isSelected}
                type="button"
                onPointerEnter={() => setActive(index)}
                onClick={() => choose(index)}
                className="w-full flex items-baseline gap-2 transition-colors"
                style={{
                  padding: '6px 8px', textAlign: 'left', fontSize: 11,
                  color: isSelected ? 'var(--accent)' : 'var(--muted)',
                  background: index === active ? 'var(--hover)' : 'transparent',
                }}>
                <span className="flex-1 truncate">{option.label}</span>
                {option.hint && <span style={{ fontSize: 10, color: 'var(--muted-3)' }}>{option.hint}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
