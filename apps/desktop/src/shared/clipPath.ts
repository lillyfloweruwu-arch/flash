// Clip and screenshot file naming, mirroring what the native ClipWriter does.
//
// The capture engine names clips in C++ (ClipWriter::GenerateClipPath), which
// is fine while only C++ creates files. Screenshots and frame grabs are created
// from TypeScript, and a screenshot sitting next to a clip with a differently
// shaped name would look like it came from another program. So the format lives
// here too, deliberately duplicated, with a self-check pinning it — the
// alternative is exporting a path builder across the N-API boundary purely to
// format a date, which is a lot of machinery for eight fields.
//
// Keep in step with packages/flash-capture/src/buffer/clip_writer.cpp.

const FORBIDDEN = /[<>:"/\\|?*]/g

// Flash names every clip and screenshot YYYY-MM-DD_HH-MM-SS, with an optional
// _N suffix for a second file in the same second. The auto-delete timer uses
// this so a general folder full of the user's own videos is left alone.
const FLASH_TIMESTAMP_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?\.(?:mp4|png)$/i

export const sidecarPath = (filePath: string): string => `${filePath}.json`

export function isFlashClipName(fileName: string): boolean {
  return FLASH_TIMESTAMP_NAME.test(fileName)
}

export function isFlashClip(fileName: string, hasSidecar: boolean): boolean {
  return hasSidecar || isFlashClipName(fileName)
}

// Local time, not UTC: the timestamp is what the player saw on their own clock,
// and a clip recorded at 9pm should not be named 02-00-00.
export function clipTimestamp(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `_${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
}

// Anything Windows refuses in a path becomes an underscore rather than being
// dropped, so two games whose names differ only in punctuation cannot collapse
// into one folder.
export function gameFolderName(game: string): string {
  const trimmed = game.trim()
  if (!trimmed) return 'Unknown'
  return trimmed.replace(FORBIDDEN, '_')
}

// Matches the native counter exactly: the first file is bare, and only the
// second onward carries a suffix.
export function numberedName(stem: string, counter: number, extension: string): string {
  return counter <= 1 ? `${stem}${extension}` : `${stem}_${counter}${extension}`
}

// `taken` is whatever already exists in the folder. Returns the first free
// name rather than overwriting, which is the one behaviour every caller of this
// depends on.
export function firstFreeName(stem: string, extension: string, taken: readonly string[]): string {
  const used = new Set(taken.map(name => name.toLowerCase()))
  for (let counter = 1; ; counter++) {
    const candidate = numberedName(stem, counter, extension)
    if (!used.has(candidate.toLowerCase()) && !used.has(sidecarPath(candidate).toLowerCase())) return candidate
  }
}
