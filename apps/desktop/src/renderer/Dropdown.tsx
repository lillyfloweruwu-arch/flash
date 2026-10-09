import { useEffect, useRef, useState } from 'react'

export type DropdownOption<T> = { value: T; label: string; hint?: string }

// A select that looks like Flash rather than like Windows.
//
// The native control cannot be styled past its border: the popup is drawn by
// the OS, in the OS's colours, at the OS's font size. This draws its own, and
// keeps the keyboard behaviour the native one gives away for free - arrows to
// move, Enter to choose, Escape to cancel, Home and End to jump - because a
// dropdown that only works with a mouse is worse than an ugly one.
export function Dropdown<T extends string | number>({ value, options, onChange, title, width = 168, variant = 'plain' }: {
  value: T
  options: DropdownOption<T>[]
  onChange: (value: T) => void
  title?: string
  width?: number
  // 'joined' butts against the button on its left, the pair reading as one control.
  variant?: 'plain' | 'joined'
}) {
  const [open, setOpen] = useState(false)
  // Opens upward when there is not room below, which is most of the time in
  // the feed, where the control sits near the bottom of the window.
  const [upward, setUpward] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect) setUpward(window.innerHeight - rect.bottom < options.length * 30 + 16)
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
        className="w-full flex items-center gap-2 transition-colors hover:bg-white/5"
        style={{
          fontSize: 12, color: 'var(--fg)', background: 'transparent',
          border: `1px solid ${open ? 'var(--line-strong)' : 'var(--line)'}`,
          borderRadius: variant === 'joined' ? '0 6px 6px 0' : 6,
          marginLeft: variant === 'joined' ? -1 : 0,
          height: variant === 'joined' ? 34 : 30,
          padding: '0 10px', textAlign: 'left',
        }}>
        <span className="flex-1 truncate">{selected?.label}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms ease', flexShrink: 0 }}>
          <path d="M2 3.5L5 6.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div role="listbox" aria-activedescendant={`dropdown-option-${active}`}
          className="absolute z-50 overflow-hidden"
          style={{
            ...(upward ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }),
            left: 0, minWidth: '100%', width: 'max-content', borderRadius: 8, padding: 4,
            background: 'var(--panel)', border: '1px solid var(--edge)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
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
                className="w-full flex items-center gap-3 transition-colors"
                style={{
                  padding: '7px 10px', textAlign: 'left', fontSize: 12, borderRadius: 5,
                  color: isSelected ? 'var(--fg)' : 'var(--muted)',
                  background: index === active ? 'var(--hover)' : 'transparent',
                }}>
                <span className="flex-1 truncate">{option.label}</span>
                {option.hint && <span style={{ fontSize: 11, color: 'var(--muted-3)' }}>{option.hint}</span>}
                <span style={{ width: 12, display: 'flex', color: 'var(--accent)' }} aria-hidden="true">
                  {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
