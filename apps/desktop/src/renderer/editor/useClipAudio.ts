import { useEffect, useState } from 'react'
import type { LiveMixTrack } from './useLiveMix'

// Decodes a clip's audio tracks separately, for anything that needs to hear
// more than track one.
//
// A video element plays only the first audio track and ignores the rest. That
// is fine when the first track has the sound in it, and silent when it does
// not - a clip where the game was quiet but you spoke plays as nothing at all,
// even though the mic track is right there. Both the player and the editor
// therefore mix natively rather than leaning on the element.
export function useClipAudio(filePath: string) {
  const [tracks, setTracks] = useState<LiveMixTrack[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setTracks([])
    setLoading(true)

    window.flash?.decodeClipAudio(filePath).then(result => {
      if (cancelled) return
      setLoading(false)
      if (result.error) {
        console.error(`Could not decode audio for ${filePath}: ${result.error}`)
        return
      }
      setTracks(result.tracks.map(track => ({ ...track, sampleRate: result.sampleRate })))
    }).catch(error => {
      if (cancelled) return
      setLoading(false)
      console.error(`Could not decode audio for ${filePath}`, error)
    })

    return () => { cancelled = true }
  }, [filePath])

  return { tracks, loading }
}
