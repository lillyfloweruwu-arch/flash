# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Electron desktop app. Windows today; Linux support is planned. The renderer is a single React window with a custom title bar.)

## Users

PC gamers who want to keep the moments that just happened in a game without thinking about recording. The app runs in the tray for days; the user presses a hotkey (or says "flash clip that") mid-game, then later opens Flash to watch, trim, star, export and share clips. Intended for public release, competing with Medal.tv, SteelSeries Moments, Outplayed and NVIDIA ShadowPlay.

## Product Purpose

Instant-replay clipping that stays out of the way: a rolling in-memory buffer of the last N seconds, saved to disk on a hotkey, with a local library and a light editor. Success is a clip saved with zero frame drops in the game, and a library a person enjoys browsing afterwards.

## Positioning

Lean and local. No account, no cloud upload, no feed, no ads, no telemetry. Hardware encoding (NVENC / AMF / QuickSync) with three separate audio tracks (game, system, mic), voice-triggered clips, and an installed size far below Medal's.

## Operating Context

- Used in two very different moments: in-game (only the hotkey, the toast and the REC state matter) and after the session (browsing, watching, editing).
- Often opened on a second monitor or alt-tabbed beside a running game, so it must be fast to open and cheap to leave open.
- Clips are organised by detected game; game titles come from a built-in list plus names the user taught it.

## Capabilities and Constraints

- Library: game filter sidebar, Starred, sort (Recent / Longest / Largest), search, multi-select, rename, star, delete, open folder, storage use.
- Player: previous/next, scrubber, volume, Copy/Drag, Show in Folder, Delete, Grab frame, Export for sharing with a size target (e.g. 10 MB).
- Editor: trim, filmstrip, per-track audio lanes with gain, saturation, smart-render save.
- Settings: theme, hotkeys (full clip, short clip, screenshot), short clip length, quality (resolution/fps), buffer length, audio capture, encoder and capture backend status, capture health, voice activation (device, language, custom phrase), games list, notifications, storage and auto-delete, start with Windows.
- Status bar items: detected game, REC state, current clip hotkey.
- Hard constraints: the renderer must stay light (it can be open next to a game); no new heavy runtime dependencies; installed size must not grow meaningfully.

## Brand Commitments

- Name "Flash", stickman-running logo, brand red #e8192c.
- A user-selectable theme picker stays; the existing palettes (Blood, Electric ultraviolet, Cobalt, Fuchsia, Deep indigo, Bone) may be retuned to fit a new look. The toast popup reads the same palette from `src/shared/themes.ts`.
- Must not feel like an RGB "gamer" product (neon glow, angled HUD chrome) and must not feel like a generic SaaS dashboard.

## Evidence on Hand

Real clip library on the owner's machine (Rocket League, Minecraft). No testimonials, user counts, benchmarks against competitors, or press exist; do not invent them.

## Product Principles

1. The game comes first: nothing Flash does may cost frames or attention while playing.
2. Clips are the content; the interface frames them and gets out of the way.
3. Local and owned: the user's files, the user's folder, no account.
4. Fast to open, fast to find, fast to share.
