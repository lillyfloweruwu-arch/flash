# Audio lanes: Discord and Music on their own tracks (piece 2 of 3)

Date: 2026-10-11
Status: awaiting review

Piece 1 was share-copy quality. Piece 3 is capture audio timing (crackle and sync) and is
not changed here, with one deliberate overlap noted under "Lane mixer".

## Problem

A clip has three audio tracks: `game`, `mic` and `other`. Everything that is not the game
or the microphone lands in `other`, so music and Discord share one slider in the editor
and cannot be muted separately. The user plays Rocket League with game sound off, so in
those clips `other` is the only track with sound in it, which is why it reads as "the
game slider".

An earlier note in this project called the silent `game` track a capture bug. It is not.
Minecraft clips from 2026-09-29 have a healthy game track (about -31 dB); Rocket League's
is silent because the game is muted.

## Goal

In the editor, Discord and Music each have their own lane with mute and gain, next to
Game, Mic and Other. The user chooses which apps count as Discord and as Music.

Decided with the user:

- Five lanes: Game, Mic, Discord, Music, Other.
- A picker in Settings assigns apps to Discord or Music ("let me pick apps"). Defaults:
  `discord.exe` and `spotify.exe`.
- Linux is staged: the five-lane file format, editor and export work on Linux now, but
  Linux capture keeps recording all desktop sound into Other. Per-app capture on Linux
  waits until it can be run on a real machine.

## Design

### Track order and old clips

On Windows a clip's tracks are identified by position, not by name. So the two new
tracks are appended and the first three keep their places:

`game, mic, other, discord, music`

A clip made before this change has three tracks and still decodes as game, mic, other.
A new clip always carries all five, silent ones included, for the same reason every clip
carries all three today: a missing track renumbers the ones after it.

The editor shows lanes in a friendlier order (Game, Mic, Discord, Music, Other); that is
a display order only.

`core/audio_tracks.h` holds the order and gains a small lookup from a track name to its
position, used everywhere a name is turned into an index (export gains on both
platforms, decode, the binding). Today three places hard-code the three names.

Cost: two more AAC tracks at the existing 192 kbps each, about 2.9 MB per minute of clip.

### Which app goes to which lane

A pure function in `core/` decides a lane from an executable name:

1. It belongs to the detected game's process tree: Game. (Unchanged; the game is still
   captured by its process ID.)
2. It is one of Flash's own processes: not recorded. Today Flash's "clip saved" sound and
   editor playback are recorded into `other`; that stops.
3. Its name is in the user's Discord list: Discord.
4. Its name is in the user's Music list: Music.
5. Anything else: Other.

Names compare without regard to case. An app in both lists counts as Discord.

### Capturing per app (Windows)

Windows lets a capture include one process tree, or exclude one process tree. It cannot
exclude several, so "Other" cannot be captured as "everything except the game, Discord
and Spotify". Instead Flash captures each app that is making sound and sums them by lane.

- Every two seconds Flash lists the audio sessions on all active output devices. Each
  session names a process. Processes are grouped into apps by walking up to the topmost
  ancestor with the same executable name, so Discord's six processes are one app,
  captured once as a tree.
- Each app that is not the game and not Flash gets its own include-tree capture, the
  same kind the game uses today, feeding the lane the rule above gives it.
- A capture is dropped when its process exits, or when the app has had no audio session
  for 30 seconds.
- At most 16 app captures run at once. Past that, further apps are not recorded and the
  status line says so.

Consequences the user accepted:

- An app that starts making sound for the first time joins up to about two seconds late.
- Windows system sounds that belong to no app are not recorded.

Two behaviours change for everyone:

- With no game detected, Flash today records the whole system mix into the Game lane.
  After this change per-app capture does not depend on a game: Game stays silent and
  desktop sound goes to Discord, Music and Other. The system-mix fallback remains only
  for a Windows build where per-app capture is unavailable, and the Settings picker then
  says per-app audio is not available.
- Changing the lists in Settings takes effect on the running capture; it does not need a
  restart, and it never rewrites clips already saved.

### Lane mixer

The clip writer expects one continuous stream of packets per track. Several apps feeding
one lane would give it overlapping packets, so a lane needs a mixer.

A new `core/` class, the lane mixer, takes packets from any number of sources, each
stamped with the capture clock, and gives out one stream per lane in fixed 10 ms packets:
the sum of whatever the sources had for that 10 ms. A stretch in which no source had any
sound is not given out at all: the timeline moves on, and the clip writer, which already
writes silence wherever a track has no packet, fills it. That keeps three mostly idle
lanes from filling the replay buffer with zeros. Its
output timestamps come from a running sample count anchored to the capture clock when
the lane starts, not from when packets happened to arrive.

- Discord, Music and Other always go through the mixer, whether they have zero, one or
  several apps.
- Game and Mic do not. They keep today's path untouched, so this piece cannot regress
  them.

The mixer holds each source's audio briefly (30 ms) before giving it out, so a packet
that arrives slightly late still lands in place; output timestamps account for that
delay. A source that falls more than 200 ms behind has its oldest audio dropped.

This is the overlap with piece 3: sample-counted timestamps are the fix piece 3 has in
mind for crackle and drift. Piece 2 uses them only for the three mixed lanes. If they
sound right there, piece 3 can move Game and Mic onto the same mixer; if not, piece 3
learns that cheaply.

### Settings

- Stored as `audioLanes: { discord: string[], music: string[] }`, executable names in
  lower case. Missing means the defaults.
- Settings, under the existing "Record audio" row, gains "App audio": a list of apps
  currently making sound, each with a three-way choice (Discord, Music, Other), followed
  by apps that are assigned but not running, each with a remove control. The game is
  shown as "Game" and cannot be reassigned.
- The single "Record audio" switch still turns every lane on or off together. Per-lane
  record switches are not part of this piece; muting is done in the editor.

### Native interface

- `setAudioLanes({ discord: string[], music: string[] })`
- `listAudioApps()` returns `[{ exe, name, lane, capturing }]` for the picker.
- `capabilities.perAppAudio` is `true` on Windows when per-app capture works, `false`
  otherwise, including on Linux.
- `setAudioTracks` and `getStatus().audioTracks` take and report five lanes.
- Export `gains` accepts `discord` and `music` beside the existing three names.

### Editor and Watch view

- Lanes are built from the decoded tracks, as today. Lane labels become proper names
  ("Discord", "Music", "Other apps") with an icon each; today the raw track id is shown.
- A lane with no sound anywhere in the clip is drawn dimmed with "no sound" in place of
  its waveform, so five lanes do not read as five things to manage.
- The Watch view already plays every decoded track at full volume; it picks up the new
  tracks with no change beyond the preview decode holding five tracks.

### Share copies and editor saves

The mixdown sums all five lanes with the editor's mute and gain choices. Nothing else
about export changes.

## Linux

Shared code changes reach Linux, and the Linux backend is edited to match. The Ubuntu CI
job compiles it and runs the portable tests; none of it is run on a Linux desktop.

- File format: the Linux muxer writes and reads tracks by title, so it accepts the two
  new names. A Linux clip keeps omitting tracks it has no packets for, as it does today.
- Export: gains are looked up by the shared name-to-position helper for five lanes.
- Capture: unchanged. All desktop sound is recorded into Other, and the microphone into
  Mic. `capabilities.perAppAudio` is `false`, `listAudioApps()` returns an empty list,
  and the Settings picker shows "Per-app audio is not available on Linux yet. Desktop
  sound is recorded to Other apps."
- The lane rule and the lane mixer live in `core/` and are compiled and unit-tested on
  Linux, so the later PipeWire work (one capture stream per application node, routed by
  the same rule into the same mixer) only has to add the capture side.
- Added to the L2 list in `docs/linux.md`: per-app capture through PipeWire, checked on
  each distro family, including Flatpak apps whose process names are hidden.

## Out of scope

- Crackle, muffled sound and sync (piece 3).
- Per-lane record switches.
- Re-splitting old clips: sound already recorded into `other` stays there.
- Share-copy picture quality (piece 1 is reopened separately: the installed AV1 copy
  measured softer than the ffmpeg reference).

## Testing

Unit tests in `packages/flash-capture/test`, written before the code, run on both CI jobs:

- Track order is the five names in the stated order; the name lookup returns the right
  position and rejects an unknown name.
- Lane rule: game tree, Flash itself, Discord list, Music list, fallback, case, an app in
  both lists.
- Lane mixer: two sources sum; a source that starts late leaves silence before it; a gap
  in a source is silence, not a repeat; output packets are exactly 10 ms, contiguous and
  in order; a source more than 200 ms behind loses its oldest audio; no sources gives
  silence at a steady cadence.
- App grouping: six processes of one executable under one root are one app; a child with
  a different name under the game belongs to the game.

Windows probe on real hardware, through the built addon, with no game needed: a helper
process plays a tone, its executable is assigned to Music, Flash records a few seconds
and saves. Expected: five tracks; the Music track carries the tone; reassigning the
helper to Discord moves the tone to the Discord track in the next clip; the Game track
is silent; the old three-track clips in the library still decode as game, mic, other.

In the running app: the Settings picker lists Spotify and Discord with the right
defaults, and a new clip opened in the editor shows five lanes with Spotify's sound on
Music only.

By the user: record a clip with Spotify playing and Discord making sound, open it in the
editor, mute Music and confirm only the music goes away, then the same for Discord.
