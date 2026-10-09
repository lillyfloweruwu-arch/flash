export type ByteRange = { status: 200 | 206; start: number; end: number } | { status: 416 }

// Only a single range is supported. Reject malformed and multipart requests
// explicitly so a bad seek cannot silently download the whole recording.
export function byteRange(header: string | null, size: number): ByteRange {
  if (!header) return { status: 200, start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return { status: 416 }
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ([first, last].some(value => value !== undefined && !Number.isSafeInteger(value))) return { status: 416 }
  if (first === undefined && last === 0) return { status: 416 }
  const start = first ?? Math.max(0, size - last!)
  const end = first === undefined || last === undefined ? size - 1 : Math.min(last, size - 1)
  return start <= end && start < size ? { status: 206, start, end } : { status: 416 }
}
