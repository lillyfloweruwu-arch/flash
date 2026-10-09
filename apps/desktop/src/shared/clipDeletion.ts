import { resolve } from 'node:path'

export type DeleteIntent = 'manual' | 'prune'

export function createClipDeletion(options: {
  allowed: (path: string, intent: DeleteIntent) => boolean
  unlink: (path: string) => void
  cleanup: (path: string) => void
  wait?: () => Promise<void>
}) {
  const pending = new Map<string, Promise<boolean>>()
  const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const remove = (path: string, intent: DeleteIntent): Promise<boolean> => {
    const id = key(path)
    const previous = pending.get(id)
    const run = async () => {
      if (previous && await previous) return true
      for (let attempt = 0; ; attempt++) {
        try {
          // There is no await between protection and unlink. A successful star
          // during a retry delay is therefore observed by the next attempt.
          if (!options.allowed(path, intent)) return false
          options.unlink(path)
          options.cleanup(path)
          return true
        } catch (error: any) {
          if (!['EBUSY', 'EPERM'].includes(error?.code) || attempt >= 10) return false
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
