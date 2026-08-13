export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function selectRange(
  selected: ReadonlySet<string>,
  displayedIds: readonly string[],
  anchorId: string | null,
  targetId: string,
): Set<string> {
  const next = new Set(selected)
  const targetIndex = displayedIds.indexOf(targetId)
  if (targetIndex < 0) return next

  const anchorIndex = anchorId == null ? -1 : displayedIds.indexOf(anchorId)
  if (anchorIndex < 0) {
    next.add(targetId)
    return next
  }

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  for (let index = start; index <= end; index++) next.add(displayedIds[index])
  return next
}

export function clearSelection(): Set<string> {
  return new Set()
}
