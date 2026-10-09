import { THEMES } from './themes.ts'

export const QUALITY_OPTIONS = [
  '720p 30fps', '720p 60fps',
  '1080p 30fps', '1080p 60fps', '1080p 120fps', '1080p 144fps',
  '1440p 60fps', '1440p 120fps', '4K 30fps', '4K 60fps',
]

// Keeps a hand-edited or half-written settings.json from taking the app down.
//
// Spreading a parsed file over the defaults fills in missing keys but keeps
// whatever type the file happened to hold, and a wrong type is not a wrong
// setting — it is a crash at the first place that reads it, which for
// `"overlayPosition": null` is during startup, before any window exists to say
// what went wrong. Anything whose shape does not match its default is dropped.
export function sanitise<T extends Record<string, unknown>>(defaults: T, parsed: unknown): Partial<T> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const source = parsed as Record<string, unknown>
  const clean: Record<string, unknown> = {}

  // Driven by the defaults, not by the file, so an unknown key cannot ride along.
  for (const key of Object.keys(defaults)) {
    const fallback = defaults[key]
    const value = source[key]
    if (value === undefined) continue

    if (key === 'perGame') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        clean[key] = Object.fromEntries(Object.entries(value).map(([game, fields]) => [game,
          sanitise({ quality: defaults.quality ?? '1080p 60fps', bufferLength: defaults.bufferLength ?? 30 }, fields),
        ]))
      }
      continue
    }
    if (Array.isArray(fallback)) {
      if (Array.isArray(value)) clean[key] = value
      continue
    }
    if (typeof fallback === 'object' && fallback !== null) {
      if (value && typeof value === 'object' && !Array.isArray(value)) clean[key] = value
      continue
    }
    if (typeof value !== typeof fallback) continue
    // typeof says number for both of these, and both poison any arithmetic
    // downstream — a NaN buffer length silently disables the ring buffer.
    if (typeof value === 'number' && !Number.isFinite(value)) continue

    if (key === 'quality' && !QUALITY_OPTIONS.includes(value as string)) continue
    if (key === 'bufferLength' && (typeof value !== 'number' || value < 10 || value > 300 || value % 5 !== 0)) continue
    if (key === 'autoDeleteDays' && ![0, 7, 30, 90].includes(value as number)) continue
    if (key === 'theme' && !Object.hasOwn(THEMES, value as string)) continue
    if (key === 'overlayPosition' && !['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(value as string)) continue
    if (['hotkey', 'hotkeyShort', 'screenshotHotkey'].includes(key) && !(value as string).trim()) continue

    clean[key] = value
  }

  const bufferLength = (clean.bufferLength ?? defaults.bufferLength) as number
  if (clean.shortClipSeconds !== undefined &&
      ((clean.shortClipSeconds as number) < 5 || (clean.shortClipSeconds as number) > bufferLength)) {
    delete clean.shortClipSeconds
  }
  return clean as Partial<T>
}
