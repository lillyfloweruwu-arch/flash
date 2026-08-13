# Voice activation, per-game settings, and renaming clips

Date: 2026-08-13
Status: approved, not yet implemented

Three features that share no code but arrive together: a spoken trigger for
saving a clip, per-game overrides for quality and clip length, and the ability
to give a clip a name instead of a timestamp.

## Voice activation

### The recogniser

`Windows.Media.SpeechRecognition` — WinRT, on-device, available since Windows
10 1607. The project already builds against C++/WinRT for
Windows.Graphics.Capture, so this adds a header and a namespace rather than a
toolchain.

Recognition uses a `SpeechRecognitionListConstraint` rather than open
dictation. The distinction matters more than it looks: with a fixed list the
recogniser only decides *which of these phrases, or none*, instead of
transcribing arbitrary speech. That is why a free on-device engine is accurate
enough here when it would not be for dictation, and it is why custom phrases
stay affordable — a user-supplied string is just another entry in the list.

No model ships in the installer. No network. The one external dependency is a
speech language pack, which Windows installs with the display language; if none
is present the recogniser fails to construct, and voice activation reports
itself unavailable in Settings rather than silently never firing.

### Where the audio comes from

`AudioCapture` already delivers every buffer through a single `AudioCallback`,
and `AudioData` already carries a `sourceId` identifying which source produced
it. Voice activation taps the microphone source inside that existing callback.

This matters for a reason beyond convenience: opening a second capture stream on
the same microphone risks fighting the first for the device. Reusing the
callback means there is exactly one microphone reader in the process, and the
recogniser is downstream of it.

Only the microphone source is fed to the recogniser. Game audio and desktop
audio are never sent, so a video playing the trigger phrase cannot fire it.

### Commands

Four phrases, three built in and one user-supplied:

| Phrase | Action |
| --- | --- |
| "Flash clip that" | Save the full buffer, same as the clip hotkey |
| "Flash clip short" | Save the short buffer, same as the short-clip hotkey |
| "Flash screenshot" | Take a screenshot, per the screenshot spec |
| *(custom)* | Save the full buffer |

Each maps onto an action that already exists and is already reachable by
hotkey. Voice adds no capability; it adds a second way to reach one.

### Listening window and false positives

Listening runs whenever Flash is open, not only while the replay buffer runs.

A recognised phrase clips immediately, with no confirmation step. This is the
correct trade for the situation the feature exists for — hands busy, moment
passing — and a wrong clip now costs one click, because multi-select delete
exists.

That combination, an always-on recogniser with a custom phrase and no confirm,
is the highest false-positive configuration this feature can be put in. Two
guards, neither of which asks the user anything:

- **A confidence floor.** `SpeechRecognitionResult` carries a confidence; below
  medium the result is discarded. A constrained grammar will happily return its
  closest match for unrelated speech, so the floor is what makes the grammar's
  accuracy real.
- **A cooldown.** After a successful trigger the recogniser ignores matches for
  several seconds. One misfire stays one misfire instead of becoming six while
  a conversation continues.

Settings warns, rather than refuses, when a custom phrase is under three
syllables. Short phrases collide with ordinary speech, and the failure looks
like a broken feature rather than a bad phrase.

Voice activation is off by default and its Settings row states plainly that
enabling it means Flash listens to the microphone while it is open. A feature
that reads a microphone should say so where it is switched on, not only in a
document.

### Files

- `packages/flash-capture/src/capture/voice_trigger.h` / `.cpp` — new. Owns the
  recogniser, the constraint list, the confidence floor and the cooldown.
  Exposes a callback that fires with a command identifier.
- `packages/flash-capture/src/capture/audio_capture.cpp` — route microphone
  buffers to the trigger when it is enabled.
- `packages/flash-capture/src/binding.cpp` — `setVoiceCommands(phrases)`,
  `setVoiceEnabled(bool)`, and a thread-safe callback into JS.
- `apps/desktop/src/main/main.ts` — map command identifiers onto the existing
  `saveClipNow` and screenshot paths; the voice trigger must not grow its own
  copy of what a clip is.

## Per-game settings

A single `perGame: Record<string, { quality?: string; bufferLength?: number }>`
map in settings, keyed by the same game name the existing learned-games map
uses. Absent keys and absent fields both mean "use the global setting", so the
map stays empty until something is actually overridden.

When game detection reports a game, the main process resolves quality and
buffer length through the map before calling `setQuality` and
`setBufferLength`. Both addon calls already exist and already handle being
called while capture is running.

In Settings, the game list gains an inline override control per game, showing
the effective value and whether it is inherited or set. Storing both settings in
one map means adding a third per-game setting later costs a field, not a
migration.

## Renaming clips

A clip's title is derived entirely from its MP4 basename in `scanClips()`, and
search already matches against that title, so a rename needs no new index and no
remux — it renames the file and its JSON sidecar together.

Rename is reachable from the clip card and from the player. Committing an
edit calls a new `rename-clip` IPC handler which:

1. Rejects characters Windows forbids in filenames, and rejects an empty name.
2. Resolves collisions by appending a counter rather than overwriting. A rename
   must never destroy another clip.
3. Renames the MP4 and the sidecar as a pair, restoring the first if the second
   fails, so the two cannot end up disagreeing about the clip's name.

The rename can fail while Chromium holds the file open — a clip that is
currently playing, or whose thumbnail is still decoding. The handler surfaces
that as a message rather than a silent no-op, and the renderer stops playback
before committing a rename on the open clip.

Screenshots rename through the same path; nothing in it is video-specific.

## Verification

- Filename validation and collision resolution go in a pure function in
  `apps/desktop/src/shared/` with assert self-checks: a forbidden character, an
  empty name, a collision, and a collision against an already-numbered name.
- Per-game resolution — which quality applies given a map, a game and the
  globals — is pure and gets the same treatment, including the case where a game
  overrides one field and inherits the other.
- The voice trigger's cooldown and confidence gate are checkable without a
  microphone: feed synthetic results through the gate and assert what passes.
  Recognition accuracy itself is not testable here and is not claimed to be.

## Deliberately not doing

- No wake-word-then-command grammar. One phrase, one action.
- No voice feedback or spoken confirmation. The existing sound and toast already
  confirm a clip.
- No per-game hotkeys, overlay position, or audio track selection. Quality and
  clip length are the two that vary by game; the rest do not.
- No rename history or undo. The file is on disk under its new name; renaming it
  again is the undo.
