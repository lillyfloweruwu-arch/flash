// Pure maths for the clip editor. No DOM and no Electron, so it can be checked
// with `node --experimental-strip-types src/shared/editor.test.ts`.

export function formatTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${Math.floor(rest).toString().padStart(2, '0')}.${Math.floor((rest % 1) * 10)}`
}

// Returns the keyframe within tolerance of `seconds`, or null. Drives both the
// snap while dragging and the lossless badge: a save stays a pure remux only
// when the in-point lands on one of these.
export function nearestKeyframe(keyframesSec: number[], seconds: number, toleranceSec: number): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const key of keyframesSec) {
    const distance = Math.abs(key - seconds)
    if (distance <= toleranceSec && distance < bestDistance) {
      best = key
      bestDistance = distance
    }
  }
  return best
}

// Keeps the pair ordered and inside the clip. Dragging one handle past the
// other pushes the other along instead of inverting the range, which is what
// every editor does and what stops the strip rendering backwards.
//
// minSpanSec is not decoration: collapsing to zero length is what a naive clamp
// does when the handles cross, and the native trimmer rejects that outright
// with "trim range contains no decodable video". Keep a floor.
export function clampRange(inSec: number, outSec: number, durationSec: number, minSpanSec = 0.1) {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const clamp = (value: number, fallback: number) =>
    Math.min(Math.max(Number.isFinite(value) ? value : fallback, 0), duration)
  let start = clamp(inSec, 0)
  let end = clamp(outSec, duration)
  if (end - start < minSpanSec) {
    if (start + minSpanSec <= duration) {
      end = start + minSpanSec
    } else {
      end = duration
      start = Math.max(0, duration - minSpanSec)
    }
  }
  return { inSec: start, outSec: end }
}
