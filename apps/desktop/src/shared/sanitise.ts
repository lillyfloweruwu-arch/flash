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

    clean[key] = value
  }

  return clean as Partial<T>
}
