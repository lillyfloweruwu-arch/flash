import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { usePlaybackVisibility } from '../usePlaybackVisibility'

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
  // Output level for the whole mix. The video element is muted, so its own
  // volume control does nothing and this is the only thing that can turn the
  // sound down.
  master = 1,
): { ready: boolean } {
  const visible = usePlaybackVisibility()
  const [ready, setReady] = useState(false)
  const gainsRef = useRef(gains)
  const gainNodesRef = useRef(new Map<string, GainNode>())
  const masterRef = useRef(master)
  const masterNodeRef = useRef<GainNode | null>(null)

  useEffect(() => {
    masterRef.current = master
    if (masterNodeRef.current) masterNodeRef.current.gain.value = master
  }, [master])

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

    if (!visible) video?.pause()
    if (!visible || !video || audibleTracks.length === 0) {
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

    // Per-track gains feed a master, so the transport's volume can move the
    // whole mix without disturbing the mixer's own per-lane levels.
    const masterNode = context.createGain()
    masterNode.gain.value = masterRef.current
    masterNode.connect(context.destination)
    masterNodeRef.current = masterNode

    const buffers = new Map<string, AudioBuffer>()
    const gainNodes = new Map<string, GainNode>()
    for (const track of audibleTracks) {
      const buffer = context.createBuffer(1, track.samples.length, track.sampleRate)
      buffer.getChannelData(0).set(track.samples)
      buffers.set(track.id, buffer)

      const gainNode = context.createGain()
      gainNode.gain.value = gainsRef.current[track.id] ?? 1
      gainNode.connect(masterNode)
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
    const onPause = () => { discardSources(); void context.suspend().catch(() => {}) }
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

    if (video.paused) void context.suspend().catch(() => {})
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
      masterNodeRef.current = null
      for (const gainNode of gainNodes.values()) gainNode.disconnect()
      masterNode.disconnect()
      void context.close().catch(error => {
        console.error('Could not close the clip editor audio context', error)
      })
    }
  }, [videoRef, tracks, visible])

  return { ready }
}
