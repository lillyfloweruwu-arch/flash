import { resolve } from 'node:path'

export type DeleteIntent = 'manual' | 'prune'

export interface DeleteResult {
  deleted: boolean
  error?: string
}

export function createClipDeletion(options: {
  allowed: (path: string, intent: DeleteIntent) => boolean
  unlink: (path: string) => void
  cleanup: (path: string) => void
  wait?: () => Promise<void>
}) {
  const pending = new Map<string, Promise<DeleteResult>>()
  const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const remove = (path: string, intent: DeleteIntent): Promise<DeleteResult> => {
    const id = key(path)
    const previous = pending.get(id)
    const run = async (): Promise<DeleteResult> => {
      const prior = previous ? await previous : undefined
      if (prior?.deleted) return prior
      for (let attempt = 0; ; attempt++) {
        try {
          // There is no await between protection and unlink. A successful star
          // during a retry delay is therefore observed by the next attempt.
          if (!options.allowed(path, intent)) return { deleted: false }
          options.unlink(path)
          options.cleanup(path)
          return { deleted: true }
        } catch (error: any) {
          const busy = ['EBUSY', 'EPERM'].includes(error?.code)
          if (!busy) return { deleted: false, error: error?.message || 'Could not delete the clip' }
          if (attempt >= 10) return { deleted: false, error: 'Close anything using this file, then try again' }
          await (options.wait?.() ?? new Promise(resolve => setTimeout(resolve, 200)))
        }
      }
    }
    const result = run().finally(() => { if (pending.get(id) === result) pending.delete(id) })
    pending.set(id, result)
    return result
  }
  return { remove, busy: (path: string) => pending.has(key(path)) }
}
