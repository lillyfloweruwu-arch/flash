import { useSyncExternalStore } from 'react'

let windowVisible = false
const listeners = new Set<() => void>()
const visible = () => windowVisible && document.visibilityState === 'visible'
const notify = () => {
  if (!visible()) document.querySelectorAll('video, audio').forEach(media => (media as HTMLMediaElement).pause())
  for (const listener of listeners) listener()
}
let unsubscribe: (() => void) | undefined
const guardPlay = (event: Event) => {
  if (!visible() && event.target instanceof HTMLMediaElement) event.target.pause()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  if (listeners.size === 1) {
    let revision = 0
    let active = true
    const off = window.flash?.onPlaybackVisibility(value => { revision++; windowVisible = value; notify() })
    // Start closed until main reports visibility, including an autostart window.
    windowVisible = false
    void window.flash?.getPlaybackVisibility().then(value => {
      if (active && revision === 0) { windowVisible = value; notify() }
    }).catch(() => {})
    document.addEventListener('visibilitychange', notify)
    document.addEventListener('play', guardPlay, true)
    unsubscribe = () => {
      active = false
      off?.()
      document.removeEventListener('visibilitychange', notify)
      document.removeEventListener('play', guardPlay, true)
    }
  }
  return () => { listeners.delete(listener); if (!listeners.size) unsubscribe?.() }
}

export function usePlaybackVisibility() {
  return useSyncExternalStore(subscribe, visible, () => false)
}
