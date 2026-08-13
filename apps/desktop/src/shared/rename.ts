const FORBIDDEN_FILENAME_CHARACTERS = /[\\/:*?"<>|]/
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function validateClipName(name: string): string | null {
  if (!name.trim()) return 'Enter a name'
  if (/^\.+$/.test(name.trim())) return 'A name cannot contain only dots'
  if (FORBIDDEN_FILENAME_CHARACTERS.test(name)) return 'Names cannot contain \\ / : * ? " < > or |'
  if (RESERVED_DEVICE_NAME.test(name.trim())) return 'That name is reserved by Windows'
  if (/[. ]$/.test(name)) return 'Names cannot end with a dot or space'
  return null
}

export function resolveClipFilename(name: string, extension: string, existingFilenames: readonly string[]): string {
  const existing = new Set(existingFilenames.map(filename => filename.toLowerCase()))
  let counter = 1

  while (true) {
    const suffix = counter === 1 ? '' : ` (${counter})`
    const basename = `${name}${suffix}`
    if (!existing.has(`${basename}${extension}`.toLowerCase()) && !existing.has(`${basename}.json`.toLowerCase())) {
      return `${basename}${extension}`
    }
    counter++
  }
}
