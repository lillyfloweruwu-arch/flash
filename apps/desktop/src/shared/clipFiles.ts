import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sidecarPath } from './clipPath.ts'
import { resolveClipFilename } from './rename.ts'

export interface Sidecar {
  duration?: number
  game?: string
  starred?: boolean
}

export function writeSidecar(filePath: string, metadata: Sidecar): void {
  writeAtomic(sidecarPath(filePath), JSON.stringify(metadata))
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function parseSidecar(path: string): Sidecar {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.starred !== undefined && typeof value.starred !== 'boolean') ||
      (value.game !== undefined && typeof value.game !== 'string') ||
      (value.duration !== undefined && (typeof value.duration !== 'number' ||
        !Number.isFinite(value.duration) || value.duration < 0))) {
    throw new Error('Invalid clip metadata')
  }
  return value
}

export function readSidecar(filePath: string): (Sidecar & { unreadable?: boolean }) | null {
  try {
    return parseSidecar(sidecarPath(filePath))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    // Losing metadata must never turn a previously protected clip into a prune candidate.
    console.warn(`Protecting clip with unreadable sidecar: ${filePath}`, error)
    return { starred: true, unreadable: true }
  }
}

export function migrateSidecars(folder: string): Set<string> {
  const protectedPaths = new Set<string>()
  const groups = new Map<string, string[]>()
  const mediaPaths = new Set<string>()
  for (const name of readdirSync(folder)) {
    const extension = extname(name).toLowerCase()
    if (!['.mp4', '.png'].includes(extension) || !statSync(join(folder, name)).isFile()) continue
    if (name.includes('.partial.')) continue
    mediaPaths.add(join(folder, name).toLowerCase())
    const stem = basename(name, extname(name)).toLowerCase()
    groups.set(stem, [...(groups.get(stem) ?? []), join(folder, name)])
  }
  for (const files of groups.values()) {
    const legacy = files[0].slice(0, -extname(files[0]).length) + '.json'
    // A name such as round.mp4.png must not consume round.mp4's new sidecar.
    if (mediaPaths.has(legacy.slice(0, -'.json'.length).toLowerCase())) continue
    try {
      const contents = readFileSync(legacy, 'utf8')
      if (files.length === 1 && !existsSync(sidecarPath(files[0]))) {
        renameSync(legacy, sidecarPath(files[0]))
      } else {
        for (const file of files) {
          if (!existsSync(sidecarPath(file))) {
            writeAtomic(sidecarPath(file), contents)
            continue
          }
          const metadata = parseSidecar(legacy)
          const existing = readSidecar(file)
          if (existing?.unreadable) throw new Error(`Unreadable destination sidecar: ${file}`)
          writeSidecar(file, { ...metadata, ...existing, starred: metadata.starred === true || existing?.starred === true })
        }
        // Keep the legacy file until every copy succeeded, so interrupted migrations can retry.
        unlinkSync(legacy)
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT' && !existsSync(legacy)) continue
      console.warn(`Protecting clips whose sidecar migration failed: ${legacy}`, error)
      for (const file of files) protectedPaths.add(file)
    }
  }
  return protectedPaths
}

const reservedOutputs = new Set<string>()

export function reserveOutput(requested: string): { path: string; release: () => void } {
  const folder = dirname(requested)
  const extension = extname(requested)
  const taken = [...readdirSync(folder), ...Array.from(reservedOutputs)
    .filter(path => dirname(path).toLowerCase() === folder.toLowerCase()).map(path => basename(path))]
  const path = join(folder, resolveClipFilename(basename(requested, extension), extension, taken))
  reservedOutputs.add(path)
  return { path, release: () => { reservedOutputs.delete(path) } }
}
