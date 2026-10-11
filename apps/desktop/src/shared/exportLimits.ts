// The share-copy size menu, shared by the renderer (which shows it) and the
// main process (which names the output file).

export type ExportCodecChoice = 'auto' | 'h264'

export interface ExportLimit {
  value: string
  label: string
  hint: string
  bytes: number
  codec: ExportCodecChoice
}

// Discord's upload ceilings. The tier is the hint rather than part of the
// label, so the size stays the thing you read first. "Compatible" is H.264:
// it plays for a viewer whose PC cannot decode the newer codecs.
export const EXPORT_LIMITS: ExportLimit[] = [
  { value: '10', label: '10MB', hint: 'Discord free', bytes: 10 * 1048576, codec: 'auto' },
  { value: '10-h264', label: '10MB compatible', hint: 'H.264, plays anywhere', bytes: 10 * 1048576, codec: 'h264' },
  { value: '50', label: '50MB', hint: 'Nitro Basic', bytes: 50 * 1048576, codec: 'auto' },
  { value: '500', label: '500MB', hint: 'Nitro', bytes: 500 * 1048576, codec: 'auto' },
]

// Linux starts on the compatible entry: when a Linux GPU has no AV1 encoder,
// the fallback is H.264 either way, and H.264 is what Linux players and Discord
// on Linux reliably decode.
export const defaultExportLimit = (platform: string | undefined): string =>
  platform === 'linux' ? '10-h264' : '10'

export const findExportLimit = (id: string): ExportLimit =>
  EXPORT_LIMITS.find(limit => limit.value === id) ?? EXPORT_LIMITS[0]

export const exportSuffix = (bytes: number, codec: ExportCodecChoice): string =>
  ` - ${Math.round(bytes / 1048576)}MB${codec === 'h264' ? ' H264' : ''}.mp4`

// Says so when "auto" could not use AV1, so a worse-looking copy is explained.
export function codecNote(requested: ExportCodecChoice, actual: string | undefined): string {
  if (requested !== 'auto' || !actual || actual === 'av1') return ''
  return `Exported as ${actual === 'hevc' ? 'HEVC' : 'H.264'} (no AV1 encoder on this GPU)`
}
