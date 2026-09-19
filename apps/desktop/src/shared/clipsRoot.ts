// Every main-process handler that takes a path from the renderer — delete,
// rename, move, trim, export, the flash-clip protocol — has to answer one
// question: is this inside the clips folder?
//
// `candidate.startsWith(root)` is not that answer. It says yes to
// "C:\Clips-old\private.mp4" for a root of "C:\Clips", because the sibling
// shares the prefix, and yes to "C:\Clips\..\Windows\notepad.exe", because the
// traversal is still a prefix match. It also says NO to a legitimate clip whose
// path differs only in case, which Windows treats as the same file.
//
// Comparing resolved path segments answers all three at once.
function segments(path: string): string[] {
  const resolved: string[] = []
  for (const segment of path.replace(/[/\\]+/g, '\\').split('\\')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { resolved.pop(); continue }
    resolved.push(segment.toLowerCase())
  }
  return resolved
}

export function isInsideRoot(root: string, candidate: string): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false
  if (!root || !candidate) return false

  const rootSegments = segments(root)
  const candidateSegments = segments(candidate)
  if (!rootSegments.length || candidateSegments.length < rootSegments.length) return false
  return rootSegments.every((segment, index) => segment === candidateSegments[index])
}
