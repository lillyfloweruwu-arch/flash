import { useEffect, useState } from 'react'
import type { LiveMixTrack } from './useLiveMix'
import { createDecodeQueue } from '../../shared/decodeQueue'
import { sortLanes } from '../../shared/audioLanes'
import { usePlaybackVisibility } from '../usePlaybackVisibility'

const requestDecode = createDecodeQueue((path: string) => window.flash.decodeClipAudio(path))

// Decodes a clip's audio tracks separately, for anything that needs to hear
// more than track one.
//
// A video element plays only the first audio track and ignores the rest. That
// is fine when the first track has the sound in it, and silent when it does
// not - a clip where the game was quiet but you spoke plays as nothing at all,
// even though the mic track is right there. Both the player and the editor
// therefore mix natively rather than leaning on the element.
export function useClipAudio(filePath: string) {
  const visible = usePlaybackVisibility()
  const [tracks, setTracks] = useState<LiveMixTrack[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setTracks([])
    setError(null)
    setLoading(!!filePath && visible)
    if (!filePath || !visible) return
    let release: (() => void) | undefined
    // A short dwell avoids starting a native decode for clips flicked past.
    const timer = setTimeout(() => {
      const request = requestDecode(filePath)
      release = request.release
      request.promise.then(result => {
        if (cancelled) return
        setLoading(false)
        if (!result) return
        if (result.error) {
          setError(result.error)
          console.error(`Could not decode audio for ${filePath}: ${result.error}`)
          return
        }
        setTracks(sortLanes(result.tracks.map(track => ({ ...track, sampleRate: result.sampleRate }))))
      }).catch(err => {
        if (cancelled) return
        setLoading(false)
        setError(err instanceof Error ? err.message : 'Audio unavailable')
        console.error(`Could not decode audio for ${filePath}`, err)
      })

    }, 120)
    return () => { cancelled = true; clearTimeout(timer); release?.() }
  }, [filePath, visible])

  return { tracks, loading, error }
}
