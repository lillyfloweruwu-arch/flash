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

An earlier draft of this spec said voice activation would tap the microphone
buffers already flowing through `AudioCapture`'s `AudioCallback`. That is not
possible. `SpeechRecognizer` has no API for pushing PCM into it — it opens an
audio input device itself and owns that stream. The design has to accept a
second microphone reader in the process.

That is workable rather than merely tolerable: WASAPI shared mode allows
multiple capture clients on one device, which is already how the recogniser
coexists with Discord or a game's own voice chat. There is no contention to
resolve.

It does have one real consequence, which the UI has to be honest about. The
recogniser listens to the **Windows default input device**, while Flash's clip
audio captures whichever microphone its own settings name. On a machine with
one microphone these are the same device and the distinction never surfaces. On
a machine with several they can differ, and voice activation would then be
listening to a microphone the user did not point Flash at. The Settings row
therefore names the device the recogniser is actually using, rather than
implying it follows the capture setting.

Because the recogniser owns its own stream, game audio and desktop audio are
never fed to it — a video playing the trigger phrase cannot fire it, which was
the property the discarded design was chasing anyway.

### Confirmed feasible

A probe under `packages/flash-capture/test/voice_probe.cpp` was built and run
before any of this was designed around, because the whole feature dies if the
answer is no. From an ordinary unpackaged Win32 process it reports:

```
OK   SpeechRecognizer constructed
     current language: English (United States)
     grammar languages installed: 1
OK   CompileConstraintsAsync status=0
OK   list constraint compiled offline
```

Constructing the recogniser outside an MSIX package works, a grammar language
pack is present, and a list constraint compiles with no network and no
online-speech privacy setting.

The probe reports rather than asserts. A machine with no speech language pack
installed is a fact about that machine, not a defect, and the feature must
degrade to "unavailable" there rather than fail a build.

What the probe does **not** establish is recognition accuracy — that a spoken
phrase is actually matched, and how often something else is. That needs a
microphone and a human voice, so it is a manual check, and no claim about
accuracy should be made until it has been done.

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
