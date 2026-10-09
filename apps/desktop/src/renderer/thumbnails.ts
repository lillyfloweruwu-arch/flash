import { useEffect, useState } from 'react'
import { clipUrl } from '../shared/editor'

// One still per clip, made once and kept on disk by the main process. Tiles
// used to be live <video> elements that were unloaded off-screen to stay under
// Chromium's decoder cap, so every scroll back showed black tiles reloading.
// An <img> from an object URL paints instantly and costs no decoder at all.

const WIDTH = 480
const HEIGHT = 270

// filePath -> object URL. Survives view switches and re-renders for the whole
// session, so a tile that has been seen once never loads again.
const ready = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()
const listeners = new Map<string, Set<(url: string) => void>>()

// Making a still means decoding a frame, which is the expensive part this
// exists to avoid doing twice. Two at a time keeps the first visit to a big
// library quick without fighting the capture encoder for the GPU decoder.
const MAX_ACTIVE = 2
let active = 0
const queue: Array<() => void> = []
function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++
      job().then(resolve, reject).finally(() => {
        active--
        queue.shift()?.()
      })
    }
    if (active < MAX_ACTIVE) run()
    else queue.push(run)
  })
}

function toUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
}

function grabStill(filePath: string): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    let settled = false
    const finish = (bytes: Uint8Array | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolve(bytes)
    }
    // A clip that cannot decode must not hold a queue slot forever.
    const timer = setTimeout(() => finish(null), 8000)
    video.addEventListener('error', () => finish(null), { once: true })
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2)
    }, { once: true })
    video.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas')
      canvas.width = WIDTH
      canvas.height = HEIGHT
      const context = canvas.getContext('2d')
      if (!context) { finish(null); return }
      // Cover-fit, matching how the tile crops the clip.
      const scale = Math.max(WIDTH / video.videoWidth, HEIGHT / video.videoHeight)
      const w = video.videoWidth * scale
      const h = video.videoHeight * scale
      context.drawImage(video, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h)
      canvas.toBlob(async blob => {
        finish(blob ? new Uint8Array(await blob.arrayBuffer()) : null)
      }, 'image/jpeg', 0.82)
    }, { once: true })
    video.src = clipUrl(filePath)
  })
}

async function load(filePath: string, kind: 'clip' | 'shot'): Promise<string | null> {
  // Screenshots are already images; the file itself is the thumbnail.
  if (kind === 'shot') return clipUrl(filePath)
  const cached = await window.flash?.readThumbnail(filePath)
  if (cached && cached.length) return toUrl(cached)
  const bytes = await schedule(() => grabStill(filePath))
  if (!bytes) return null
  window.flash?.writeThumbnail(filePath, bytes)
  return toUrl(bytes)
}

export function thumbnailFor(filePath: string, kind: 'clip' | 'shot' = 'clip'): Promise<string | null> {
  const known = ready.get(filePath)
  if (known) return Promise.resolve(known)
  let job = pending.get(filePath)
  if (!job) {
    job = load(filePath, kind).then(url => {
      pending.delete(filePath)
      if (url) {
        ready.set(filePath, url)
        listeners.get(filePath)?.forEach(listener => listener(url))
      }
      return url
    }, () => { pending.delete(filePath); return null })
    pending.set(filePath, job)
  }
  return job
}

// The still for a clip: available synchronously once it has been seen, so
// remounting a tile paints on its first frame with no flash.
export function useThumbnail(filePath: string | undefined, kind: 'clip' | 'shot' = 'clip', enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(() => (filePath ? ready.get(filePath) ?? null : null))
  useEffect(() => {
    if (!filePath) { setUrl(null); return }
    const known = ready.get(filePath)
    setUrl(known ?? null)
    if (known || !enabled) return
    const set = listeners.get(filePath) ?? new Set()
    set.add(setUrl)
    listeners.set(filePath, set)
    void thumbnailFor(filePath, kind)
    return () => { set.delete(setUrl) }
  }, [filePath, kind, enabled])
  return url
}
