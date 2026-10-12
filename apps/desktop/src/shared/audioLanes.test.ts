// Self-check for audio lane naming, ordering and the Settings lists. Run with:
//   node --experimental-strip-types src/shared/audioLanes.test.ts
import { strict as assert } from 'node:assert'
import {
  AUDIO_TRACK_IDS, DEFAULT_AUDIO_LANES, LANE_DISPLAY_ORDER, assignApp, isSilent, laneLabel,
  sanitiseAudioLanes, sortLanes,
} from './audioLanes.ts'

// File order is a format: the first three never move.
assert.deepEqual([...AUDIO_TRACK_IDS], ['game', 'mic', 'other', 'discord', 'music'])
assert.deepEqual([...LANE_DISPLAY_ORDER].sort(), [...AUDIO_TRACK_IDS].sort())

assert.equal(laneLabel('game'), 'Game')
assert.equal(laneLabel('mic'), 'Mic')
assert.equal(laneLabel('discord'), 'Discord')
assert.equal(laneLabel('music'), 'Music')
assert.equal(laneLabel('other'), 'Other apps')
assert.equal(laneLabel('mystery'), 'mystery')

// A new clip's five tracks are shown Game, Mic, Discord, Music, Other.
const five = AUDIO_TRACK_IDS.map(id => ({ id }))
assert.deepEqual(sortLanes(five).map(t => t.id), ['game', 'mic', 'discord', 'music', 'other'])
// An old clip has three and gets no phantom lanes.
assert.deepEqual(sortLanes([{ id: 'game' }, { id: 'mic' }, { id: 'other' }]).map(t => t.id), ['game', 'mic', 'other'])
// An unknown track goes last and is not dropped.
assert.deepEqual(sortLanes([{ id: 'zzz' }, { id: 'mic' }]).map(t => t.id), ['mic', 'zzz'])
// sortLanes does not reorder its argument.
assert.deepEqual(five.map(t => t.id), [...AUDIO_TRACK_IDS])

assert.equal(isSilent(new Float32Array(0)), true)
assert.equal(isSilent(new Float32Array(4800)), true)
assert.equal(isSilent(Float32Array.from([0, 0.00001, -0.00001])), true)   // below hearing
const withSound = new Float32Array(4800); withSound[4000] = -0.2
assert.equal(isSilent(withSound), false)

assert.deepEqual(DEFAULT_AUDIO_LANES, { discord: ['discord.exe'], music: ['spotify.exe'] })

// Settings arrive from a file a person can edit. Junk never crashes; it is
// dropped, and a wrong shape means "use the defaults".
assert.equal(sanitiseAudioLanes('x'), undefined)
assert.equal(sanitiseAudioLanes(null), undefined)
assert.equal(sanitiseAudioLanes([]), undefined)
assert.equal(sanitiseAudioLanes({ discord: 'discord.exe', music: [] }), undefined)
assert.deepEqual(sanitiseAudioLanes({ discord: [], music: [] }), { discord: [], music: [] })   // empty is a choice
assert.deepEqual(sanitiseAudioLanes({ discord: [' Discord.EXE ', 'discord.exe', 5, null, ''], music: ['Spotify.exe'] }),
  { discord: ['discord.exe'], music: ['spotify.exe'] })
// A path is not an executable name.
assert.deepEqual(sanitiseAudioLanes({ discord: ['C:\Apps\Discord.exe', 'a/b.exe'], music: ['ok.exe'] }),
  { discord: [], music: ['ok.exe'] })
// An app in both lists is Discord.
assert.deepEqual(sanitiseAudioLanes({ discord: ['vlc.exe'], music: ['vlc.exe', 'spotify.exe'] }),
  { discord: ['vlc.exe'], music: ['spotify.exe'] })
// Bounded.
const many = Array.from({ length: 200 }, (_, i) => `app${i}.exe`)
assert.equal(sanitiseAudioLanes({ discord: many, music: [] })!.discord.length, 64)

// Moving an app between lanes.
const start = { discord: ['discord.exe'], music: ['spotify.exe'] }
assert.deepEqual(assignApp(start, 'VLC.exe', 'music'), { discord: ['discord.exe'], music: ['spotify.exe', 'vlc.exe'] })
assert.deepEqual(assignApp(start, 'spotify.exe', 'discord'), { discord: ['discord.exe', 'spotify.exe'], music: [] })
assert.deepEqual(assignApp(start, 'Discord.exe', 'other'), { discord: [], music: ['spotify.exe'] })
assert.deepEqual(assignApp(start, 'chrome.exe', 'other'), start)
assert.deepEqual(start, { discord: ['discord.exe'], music: ['spotify.exe'] })   // not mutated

console.log('audioLanes self-check passed')
