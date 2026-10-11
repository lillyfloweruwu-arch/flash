import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
  const id = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState(300)
  const [anchor, setAnchor] = useState({ left: 0, top: 0, bottom: 0, width })
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
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture phase: the clip player and editor both listen for Escape and
    // would close underneath this popup otherwise.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); rootRef.current?.querySelector('button')?.focus() }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, options, value])

  // The settings scroller would clip an absolute popup, so place the menu
  // in the document and keep its bounds tied to the trigger.
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight) { setOpen(false); return }
      const above = rect.top - 14
      const below = window.innerHeight - rect.bottom - 14
      const up = below < Math.min(320, options.length * 32 + 8) && above > below
      setUpward(up)
      const menuWidth = Math.max(rect.width, menuRef.current?.offsetWidth ?? 0)
      setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)), top: rect.bottom + 6, bottom: window.innerHeight - rect.top + 6, width: rect.width })
      setMaxHeight(Math.max(0, Math.min(320, up ? above : below)))
    }
    position()
    const observer = new ResizeObserver(position)
    if (rootRef.current) observer.observe(rootRef.current)
    if (menuRef.current) observer.observe(menuRef.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open, options.length])

  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const option = menu?.children[active] as HTMLElement | undefined
    if (!menu || !option) return
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight
    }
  }, [active, open, maxHeight])

  const choose = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
    rootRef.current?.querySelector('button')?.focus()
  }

  const onButtonKey = (event: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) event.stopPropagation()
    if (event.key === 'Tab') setOpen(false)
    if (!open && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
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
    <div ref={rootRef} onKeyDown={onButtonKey} onWheel={event => { if (open) event.stopPropagation() }} className="relative shrink-0" style={{ width }}>
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        onClick={() => setOpen(o => !o)}
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

      {open && createPortal(
        <div ref={menuRef} id={`${id}-list`} role="listbox"
          style={{
            position: 'fixed', zIndex: 110,
            ...(upward ? { bottom: anchor.bottom } : { top: anchor.top }),
            maxHeight, overflowY: 'auto', overscrollBehavior: 'contain',
            left: anchor.left, minWidth: anchor.width, width: 'max-content', maxWidth: 'calc(100vw - 16px)', borderRadius: 8, padding: 4,
            background: 'var(--panel)', border: '1px solid var(--edge)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
          }}>
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
              <button
                key={String(option.value)}
                id={`${id}-option-${index}`}
                tabIndex={-1}
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
                {option.hint && <span style={{ fontSize: 11, color: 'var(--muted-3)', whiteSpace: 'nowrap' }}>{option.hint}</span>}
                <span style={{ width: 12, display: 'flex', color: 'var(--accent)' }} aria-hidden="true">
                  {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
                </span>
              </button>
            )
          })}
        </div>, document.body
      )}
    </div>
  )
}
