// Audio lanes: the tracks of a clip, how they are named and ordered on screen,
// and the user's lists of which apps count as Discord and as Music.

// File order. A track is identified by its position in a clip, so this is a
// format shared with the native writer: the first three never move.
export const AUDIO_TRACK_IDS = ['game', 'mic', 'other', 'discord', 'music'] as const
export type AudioTrackId = typeof AUDIO_TRACK_IDS[number]

// The order lanes are shown in, which is not the file order: the catch-all
// reads better last.
export const LANE_DISPLAY_ORDER: readonly AudioTrackId[] = ['game', 'mic', 'discord', 'music', 'other']

const LABELS: Record<string, string> = {
  game: 'Game', mic: 'Mic', discord: 'Discord', music: 'Music', other: 'Other apps',
}
export const laneLabel = (id: string): string => LABELS[id] ?? id

// Display order for whatever tracks a clip really has. An old clip has three
// and shows three; a track this build does not know goes last.
export function sortLanes<T extends { id: string }>(tracks: readonly T[]): T[] {
  const rank = (id: string) => {
    const index = (LANE_DISPLAY_ORDER as readonly string[]).indexOf(id)
    return index < 0 ? LANE_DISPLAY_ORDER.length : index
  }
  return [...tracks].sort((a, b) => rank(a.id) - rank(b.id))
}

// A lane with nothing audible in it. Every new clip carries all five tracks,
// and most of them are empty most of the time.
export function isSilent(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) if (samples[i] > 1e-4 || samples[i] < -1e-4) return false
  return true
}

export interface AudioLanesSetting { discord: string[]; music: string[] }

export const DEFAULT_AUDIO_LANES: AudioLanesSetting = { discord: ['discord.exe'], music: ['spotify.exe'] }

const MAX_APPS = 64
// An executable name, not a path: nothing Windows forbids in a file name.
const EXE_NAME = /^[^\\/:*?"<>|]{1,128}$/

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => EXE_NAME.test(entry))
  return [...new Set(names)].slice(0, MAX_APPS)
}

// Undefined means "not usable, keep the defaults". Two empty lists are a
// legitimate choice and are kept.
export function sanitiseAudioLanes(value: unknown): AudioLanesSetting | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const discord = cleanList(source.discord)
  const music = cleanList(source.music)
  if (!discord || !music) return undefined
  // In both lists counts as Discord, the same rule the capture engine applies.
  return { discord, music: music.filter(exe => !discord.includes(exe)) }
}

// The lists after moving one app. "other" removes it from both.
export function assignApp(lanes: AudioLanesSetting, exe: string, lane: 'discord' | 'music' | 'other'): AudioLanesSetting {
  const name = exe.trim().toLowerCase()
  const without = (list: string[]) => list.filter(entry => entry !== name)
  const next: AudioLanesSetting = { discord: without(lanes.discord), music: without(lanes.music) }
  if (lane !== 'other') next[lane] = [...next[lane], name]
  return next
}
