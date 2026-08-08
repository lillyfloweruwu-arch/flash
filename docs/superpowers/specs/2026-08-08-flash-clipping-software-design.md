# Flash — Game Clipping Software Design Spec

**Date:** 2026-08-08
**Status:** Approved

## Overview

Flash is a lightweight game clipping software (Medal.tv alternative) that continuously records gameplay in a ring buffer and saves clips on hotkey press. Core complaint about Medal: bloat. Flash must stay lean.

## Architecture

### Monorepo Layout

```
Flash/
├── apps/desktop/           # Electron + React UI
├── packages/
│   ├── flash-capture/      # C++ native addon (screen capture + encoding)
│   ├── flash-overlay/      # C++ DLL (in-game DirectX/Vulkan overlay)
│   ├── flash-detector/     # C# game detection
│   └── flash-common/       # Shared TS types
├── assets/sounds/          # Custom notification WAV
└── docs/
```

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Electron + React + TypeScript | Desktop app shell + UI |
| UI Styling | Tailwind CSS v4 | Matches existing layout |
| Capture | C++ (node-addon-api) | DXGI Desktop Duplication screen capture |
| Encoding | C++ (NVENC + AMF) | Hardware-accelerated H.264 encoding |
| Audio | C++ (WASAPI) | Game audio + microphone capture |
| Overlay | C++ DLL injection | DirectX 11/12 + Vulkan in-game HUD |
| Game Detection | C# (.NET) | Process scanning + game database |
| Build | CMake + node-gyp | C++ native module compilation |

### Capture Pipeline

```
DXGI Desktop Duplication (screen frames)
    + WASAPI (audio streams)
         ↓
    Ring Buffer (circular, last N seconds of encoded frames)
         ↓ [F8 hotkey pressed]
    Flush ring buffer to MP4 (H.264 video + AAC audio)
         ↓
    Save to local clips directory
         ↓
    Notification popup + custom sound
```

### Ring Buffer Design

- Continuous capture at configured quality (720p–4K)
- Configurable buffer length (10–120 seconds, default 30s)
- Encoded frames stored in memory ring buffer to minimize RAM usage
- Hardware encoder (NVENC/AMF) runs continuously at low GPU overhead
- On clip save: flush buffer contents to MP4 container
- Auto-detect GPU vendor at startup, select encoder accordingly
- Software fallback (x264 via FFmpeg) if no hardware encoder available

### Game Overlay

- DLL injected into game process
- Hooks DirectX 11 Present, DirectX 12 Present, Vulkan vkQueuePresentKHR
- Renders minimal HUD:
  - Recording indicator (red dot + "REC") — top-left corner
  - "Clipped! 0:30" popup on clip save — top-left, auto-dismiss after 3s
- Communication between overlay DLL and main Electron app via named pipe
- Must not trigger anti-cheat (use well-known hooking patterns similar to Steam/Discord overlay)

### Game Detection

- C# service scanning running processes against known game database
- Game database: JSON file mapping process names to game titles
- Auto-detect game launch/exit
- Report detected game to Electron main process via IPC
- Sidebar in UI auto-filters by detected game

### Notification System

- Custom Flash notification sound (short, satisfying clip-save confirmation)
- Top-left screen popup (Electron BrowserWindow, frameless, always-on-top, click-through)
- Shows: "Clipped! {duration}" with Flash branding
- Auto-dismiss after 3 seconds with fade animation
- Sound plays via system audio, not game audio channel
- Only triggers on clip save (not social events)

### UI (from Figma layout)

Porting existing React layout into Electron renderer:

**Views:**
- Home — clip feed (trending, from followed users — placeholder for now)
- My Clips — grid of saved clips, sortable (Recent/Most Viewed/Most Liked/Longest)
- Highlights — auto-detected highlights (future: ML-based kill detection)
- Following — social feed (future, placeholder)
- Trending — popular clips (future, placeholder)
- Settings — capture config, notifications, storage, account

**Components:**
- TopBar — logo, nav tabs, REC indicator, hotkey badge, user avatar
- Sidebar — New Clip button, game filter list, storage usage, recent activity
- ClipCard — thumbnail with game tag, duration, views/likes, hover play overlay
- ClipPreview — full modal player with progress bar, prev/next, like/share/download
- SettingsPanel — capture settings, notification toggles, storage management
- NotificationPopup — frameless overlay window for "Clipped!" toast

**Design tokens:**
- Primary: #e8192c (Flash red)
- Background: #0a0008 (near-black with purple tint)
- Surface: #0e000e
- Font: Inter (body), Rajdhani (display)
- Logo: Stickman running icon + "flash." text mark

### System Tray

- Minimize to system tray (not taskbar)
- Tray icon with context menu:
  - Show/Hide Flash
  - Start/Stop Recording
  - Settings
  - Quit
- Tray icon changes color when recording active

### Local Storage

- Clips saved to `%USERPROFILE%/Videos/Flash/` by default
- Clip metadata stored in local SQLite database
- Thumbnails auto-generated from first frame
- Configurable auto-delete after N days
- Storage usage tracked and displayed in sidebar + settings

## Build Phases

### Phase 1: Capture Engine + Bare Shell (CURRENT)
- [ ] Electron app shell with minimal UI
- [ ] C++ native addon: DXGI screen capture
- [ ] C++ native addon: NVENC encoder
- [ ] C++ native addon: AMF encoder
- [ ] C++ native addon: Ring buffer
- [ ] C++ native addon: WASAPI audio capture
- [ ] C++ native addon: MP4 muxer (clip writer)
- [ ] Global hotkey system (F8)
- [ ] Notification popup window + custom sound
- [ ] System tray integration
- [ ] Local file storage + SQLite metadata

### Phase 2: Full UI
- [ ] Port Figma layout to Electron renderer
- [ ] Clip library with grid view
- [ ] Video player (clip preview modal)
- [ ] Settings panel (all capture/notification/storage settings)
- [ ] Game sidebar filter
- [ ] Sort/filter clips

### Phase 3: Game Detection + Overlay
- [ ] C# game detector service
- [ ] Game database (process name → game title)
- [ ] DirectX 11/12 overlay hook
- [ ] Vulkan overlay hook
- [ ] In-game HUD (REC indicator + clip saved popup)
- [ ] Named pipe IPC between overlay and Electron

### Phase 4: Clip Editor
- [ ] Trim/cut timeline
- [ ] Crop tool
- [ ] Speed adjustment
- [ ] Text overlay
- [ ] GIF export
- [ ] Re-encode and save

### Phase 5: Cloud & Social (future, needs VPS)
- [ ] User accounts
- [ ] Clip upload + share links
- [ ] Social feed
- [ ] Following system
- [ ] Trending algorithm

## Anti-Bloat Principles

1. No background services that aren't needed — capture engine only runs when app is open
2. No telemetry, no analytics, no tracking
3. Single native process for capture (not 5 helper processes like Medal)
4. Minimal dependencies — stdlib and native APIs first
5. Lazy-load UI views (don't render what's not visible)
6. Target < 100MB installed size (Medal is 500MB+)
