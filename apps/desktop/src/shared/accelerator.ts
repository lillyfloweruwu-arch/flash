// Browser KeyboardEvent -> Electron accelerator string.
//
// Keyed off e.code rather than e.key so a binding is tied to the physical key
// and does not move when the keyboard layout changes. Returns null for presses
// that cannot be a hotkey on their own (bare modifiers) or that Electron's
// accelerator parser would reject.

type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

const NAMED = new Set([
  'Space', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Delete',
  'Backspace', 'Tab', 'Enter', 'PrintScreen', 'ScrollLock', 'Pause',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
])

const PUNCTUATION: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
}

export function toAccelerator(e: KeyLike): string | null {
  const code = e.code
  let key = ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`
  else if (NAMED.has(code)) key = code === 'ArrowUp' ? 'Up' : code === 'ArrowDown' ? 'Down'
    : code === 'ArrowLeft' ? 'Left' : code === 'ArrowRight' ? 'Right' : code
  else if (code in PUNCTUATION) key = PUNCTUATION[code]
  else return null

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  parts.push(key)
  return parts.join('+')
}
