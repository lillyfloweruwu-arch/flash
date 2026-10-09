import { posix, win32 } from 'node:path'

// Compare resolved segments, with case folding only on Windows and macOS.
export function isInsideRoot(root: string, candidate: string, platform = process.platform): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !root || !candidate) return false
  const paths = platform === 'win32' ? win32 : posix
  if (!paths.isAbsolute(root) || !paths.isAbsolute(candidate)) return false
  let base = paths.resolve(root), target = paths.resolve(candidate)
  if (platform === 'win32' || platform === 'darwin') {
    base = base.toLowerCase()
    target = target.toLowerCase()
  }
  const relative = paths.relative(base, target)
  return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`))
}
