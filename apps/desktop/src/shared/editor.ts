// Pure maths for the clip editor. No DOM and no Electron, so it can be checked
// with `node --experimental-strip-types src/shared/editor.test.ts`.

import { clipDisplayTitle } from './clipTitle.ts'


export function matchesQuery(clip: { title: string; game: string }, query: string): boolean {
  const needle = query.toLowerCase()
  // The displayed title too, or searching for what you can plainly read on the
  // card finds nothing: an unrenamed clip shows "13 Sep · 2:45:12 AM" and is
  // called "2026 09 13 02 45 12".
  return clip.title.toLowerCase().includes(needle) ||
    clipDisplayTitle(clip.title).toLowerCase().includes(needle) ||
    clip.game.toLowerCase().includes(needle)
}

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

export type SaveReason = 'none' | 'trim' | 'audio' | 'video'

// Reports the most expensive thing the save will do, not the first one found.
// Re-encoding video dominates re-encoding audio, which dominates re-encoding a
// single GOP at the head, and the user should be told the worst of it rather
// than the mildest.
export function deriveSaveMode(inOnKeyframe: boolean, gains: number[], saturation: number):
  { lossless: boolean; reason: SaveReason } {
  if (saturation !== 100) return { lossless: false, reason: 'video' }
  if (gains.some(gain => gain !== 1)) return { lossless: false, reason: 'audio' }
  if (!inOnKeyframe) return { lossless: false, reason: 'trim' }
  return { lossless: true, reason: 'none' }
}

// Peak per bucket, not mean. A mean waveform flattens exactly the thing the
// user is looking for â€” the one loud frame where something happened.
export function reducePeaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(0, buckets))
  if (!out.length || !samples.length) return out
  const span = samples.length / out.length
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * span)
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * span)))
    let peak = 0
    for (let j = start; j < end; j++) {
      const magnitude = Math.abs(samples[j])
      if (magnitude > peak) peak = magnitude
    }
    out[i] = peak
  }
  return out
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

// Clips are served over the flash-clip scheme, not file://. A renderer page on
// http://localhost:5173 - which is what the dev build is - cannot load file://
// media at all: Chromium rejects it outright. The custom scheme works
// identically in both builds. See registerClipProtocol in main.ts.
// The "local" host is not decoration. flash-clip is a standard scheme, so
// Chromium parses the first segment after // as a hostname: without a host,
// "flash-clip:///C:/Users/..." becomes host "c" and path "/Users/...", the
// drive letter is swallowed, and the file is never found. Measured, not
// theorised - it fails with MEDIA_ELEMENT_ERROR: Format error.
// Encoded per segment rather than with encodeURI over the whole path, because
// encodeURI leaves '#', '?' and '&' alone: a clip named "round#2.mp4" is then
// requested as "round" with "2.mp4" as a URL fragment, and plays as missing.
export function clipUrl(filePath: string): string {
  const windows = /^[a-z]:[\\/]/i.test(filePath) || filePath.startsWith('\\\\')
  const path = (windows ? filePath.replace(/\\/g, '/') : filePath).split('/').map(encodeURIComponent).join('/')
  return 'flash-clip://local' + (windows ? '/' : '') + path
}
