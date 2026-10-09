// Native decoders cannot be interrupted once started. Keep one running job and
// one replaceable pending job, and retain no decoded buffers after delivery.
export function createDecodeQueue<T>(decode: (path: string) => Promise<T>) {
  type Job = { path: string; users: number; promise: Promise<T | undefined>; resolve: (value: T | undefined) => void; reject: (error: unknown) => void }
  let running: Job | undefined
  let pending: Job | undefined
  const start = (job: Job) => {
    running = job
    void Promise.resolve().then(() => decode(job.path)).then(job.resolve, job.reject).finally(() => {
      running = undefined
      const next = pending
      pending = undefined
      if (next && next.users) start(next)
    })
  }
  return (path: string) => {
    let job = running?.path === path ? running : pending?.path === path ? pending : undefined
    if (!job) {
      let resolve!: Job['resolve'], reject!: Job['reject']
      const promise = new Promise<T | undefined>((yes, no) => { resolve = yes; reject = no })
      job = { path, users: 0, promise, resolve, reject }
      if (!running) start(job)
      else {
        pending?.resolve(undefined)
        pending = job
      }
    }
    job.users++
    const owned = job
    let released = false
    return { promise: job.promise, release: () => {
      if (released) return
      released = true
      owned.users--
      if (pending === owned && !owned.users) { pending = undefined; owned.resolve(undefined) }
    } }
  }
}
