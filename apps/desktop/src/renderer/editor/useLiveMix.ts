import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export type LiveMixTrack = {
  id: string
  samples: Float32Array
  sampleRate: number
}

// Web Audio owns playback while the muted video remains the clock. Source
// nodes are deliberately short-lived: the platform makes them single-use, so
// every transport discontinuity discards them and starts a fresh synced set.
export function useLiveMix(
  videoRef: RefObject<HTMLVideoElement | null>,
  tracks: LiveMixTrack[],
  gains: Record<string, number>,
): { ready: boolean } {
  const [ready, setReady] = useState(false)
  const gainsRef = useRef(gains)
  const gainNodesRef = useRef(new Map<string, GainNode>())

  // Gain is the one part of the graph that changes in place. Keeping this in
  // its own effect prevents a slider move from rebuilding buffers or sources.
  useEffect(() => {
    gainsRef.current = gains
    for (const [id, gainNode] of gainNodesRef.current) {
      gainNode.gain.value = gains[id] ?? 1
    }
  }, [gains])

  useEffect(() => {
    const video = videoRef.current
    const audibleTracks = tracks.filter(track => track.samples.length > 0)
    setReady(false)
    gainNodesRef.current = new Map()

    if (!video || audibleTracks.length === 0) {
      setReady(tracks.length > 0)
      return
    }

    let context: AudioContext
    try {
      context = new AudioContext()
    } catch (error) {
      console.error('Could not create the clip editor audio context', error)
      return
    }

    const buffers = new Map<string, AudioBuffer>()
    const gainNodes = new Map<string, GainNode>()
    for (const track of audibleTracks) {
      const buffer = context.createBuffer(1, track.samples.length, track.sampleRate)
      buffer.getChannelData(0).set(track.samples)
      buffers.set(track.id, buffer)

      const gainNode = context.createGain()
      gainNode.gain.value = gainsRef.current[track.id] ?? 1
      gainNode.connect(context.destination)
      gainNodes.set(track.id, gainNode)
    }
    gainNodesRef.current = gainNodes

    let sourceNodes: AudioBufferSourceNode[] = []
    let syncGeneration = 0

    const discardSources = () => {
      syncGeneration += 1
      for (const source of sourceNodes) {
        source.stop()
        source.disconnect()
      }
      sourceNodes = []
    }

    const startSources = async () => {
      discardSources()
      const generation = syncGeneration
      try {
        await context.resume()
      } catch (error) {
        if (context.state !== 'closed') console.error('Could not resume clip editor audio', error)
        return
      }
      if (generation !== syncGeneration || video.paused || video.ended) return

      const offset = Math.max(0, video.currentTime)
      const rate = video.playbackRate
      const when = context.currentTime
      const nextSources: AudioBufferSourceNode[] = []

      for (const [id, buffer] of buffers) {
        if (offset >= buffer.duration) continue
        const source = context.createBufferSource()
        source.buffer = buffer
        source.playbackRate.value = rate
        source.connect(gainNodes.get(id)!)
        nextSources.push(source)
      }

      if (generation !== syncGeneration || video.paused || video.ended) {
        for (const source of nextSources) source.disconnect()
        return
      }

      sourceNodes = nextSources
      for (const source of sourceNodes) source.start(when, offset)
    }

    const onPlay = () => { void startSources() }
    const onPause = () => discardSources()
    const onSeeking = () => discardSources()
    const onSeeked = () => {
      if (!video.paused && !video.ended) void startSources()
    }
    const onRateChange = () => {
      discardSources()
      if (!video.paused && !video.ended) void startSources()
    }
    const onEnded = () => discardSources()

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('ratechange', onRateChange)
    video.addEventListener('ended', onEnded)

    setReady(true)
    if (!video.paused && !video.ended) void startSources()

    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('ratechange', onRateChange)
      video.removeEventListener('ended', onEnded)
      discardSources()
      gainNodesRef.current = new Map()
      for (const gainNode of gainNodes.values()) gainNode.disconnect()
      void context.close().catch(error => {
        console.error('Could not close the clip editor audio context', error)
      })
    }
  }, [videoRef, tracks])

  return { ready }
}
