---
name: Flash
description: Local instant-replay clipper whose home screen is one clip owning the window, the next a flick away.
colors:
  ground: "#0a0a0b"
  panel: "#121316"
  edge: "#2a2d34"
  edge-soft: "#202228"
  bone-white: "#f2f3f5"
  ash: "#9aa0ab"
  ash-2: "#80858e"
  ash-3: "#666a71"
  ash-faint: "#44464b"
  hairline: "rgba(242, 243, 245, 0.3)"
  hairline-strong: "rgba(242, 243, 245, 0.7)"
  glass: "rgba(242, 243, 245, 0.07)"
  scrim: "rgba(4, 4, 6, 0.86)"
  flash-red: "#e8192c"
  flash-red-wash: "rgba(232, 25, 44, 0.16)"
  flash-red-line: "rgba(232, 25, 44, 0.45)"
  on-accent: "#ffffff"
  spark: "#ffb020"
  alert-rose: "#ff6b8e"
  live-green: "#4ade80"
typography:
  display-hero:
    fontFamily: "'Antonio Variable', 'Bahnschrift SemiCondensed', 'Arial Narrow', sans-serif"
    fontSize: "clamp(64px, 17vh, 168px)"
    fontWeight: 600
    lineHeight: 0.86
    letterSpacing: "-0.005em"
    fontFeature: "\"tnum\""
  headline:
    fontFamily: "'Antonio Variable', 'Bahnschrift SemiCondensed', 'Arial Narrow', sans-serif"
    fontSize: "56px"
    fontWeight: 600
    lineHeight: 0.92
    letterSpacing: "-0.005em"
  title:
    fontFamily: "'Antonio Variable', 'Bahnschrift SemiCondensed', 'Arial Narrow', sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 0.92
    letterSpacing: "-0.005em"
  title-sm:
    fontFamily: "'Antonio Variable', 'Bahnschrift SemiCondensed', 'Arial Narrow', sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 0.92
    letterSpacing: "-0.005em"
  body:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', Cantarell, Ubuntu, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', Cantarell, Ubuntu, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"tnum\""
  label:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', Cantarell, Ubuntu, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.14em"
  label-small:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', Cantarell, Ubuntu, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "0.14em"
rounded:
  keycap: "4px"
  control: "6px"
  popover: "8px"
  dialog: "10px"
  pill: "999px"
spacing:
  seam: "2px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  gutter: "48px"
components:
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.bone-white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "34px"
  button-outline-hover:
    backgroundColor: "{colors.glass}"
  button-solid:
    backgroundColor: "{colors.bone-white}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "34px"
  button-small:
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "28px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.alert-rose}"
    rounded: "{rounded.control}"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ash-3}"
    typography: "{typography.label}"
    padding: "6px 0"
  tab-active:
    textColor: "{colors.bone-white}"
  field:
    backgroundColor: "transparent"
    textColor: "{colors.bone-white}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
  keycap:
    backgroundColor: "transparent"
    textColor: "{colors.ash}"
    rounded: "{rounded.keycap}"
    padding: "0 7px"
    height: "22px"
  rec-pill-live:
    backgroundColor: "{colors.flash-red-wash}"
    textColor: "{colors.bone-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "28px"
  toggle-on:
    backgroundColor: "{colors.flash-red}"
    rounded: "{rounded.pill}"
    width: "36px"
    height: "20px"
  tile-glyph:
    backgroundColor: "rgba(0, 0, 0, 0.55)"
    textColor: "{colors.bone-white}"
    rounded: "{rounded.pill}"
    size: "30px"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.bone-white}"
    rounded: "{rounded.dialog}"
    padding: "28px"
---

# Design System: Flash

## Overview

**Creative North Star: "The Screening Room After Midnight"**

Flash is a dark room with one clip on the wall. The home screen (shown to people as Watch) gives the whole window to the newest clip, footage `contain`-fitted on pure black, and lays the interface over it as white outlined glyphs and tall condensed capitals sitting on soft gradient scrims. The next clip is one wheel flick, arrow key or J/K away, and the transition is a short rise from the direction you moved. Library and Settings are the same room with the lights half up: near-black ground with a static film-grain tile, the same Antonio capitals for names and dates, the same tracked small caps for every label.

The system is deliberately quiet so the footage can be loud. Neutrals carry a faint per-theme tint and are tuned per palette; the theme accent is withheld from chrome and only appears where something is live or engaged: the REC dot, a starred clip, a selected tile, an enabled toggle, a chosen dropdown option, trim handles. Density is low on Watch (one item, generous 48px gutters) and higher in Library (a 2px-seam mosaic of 16:9 tiles), but the vocabulary never changes between them.

Confirmed rejections, from PRODUCT.md and the build's own direction: not the dark-dashboard card grid every clipper ships, not an RGB gamer product (no neon glow, no angled HUD chrome), not a generic SaaS dashboard.

**Key Characteristics:**
- Footage is full-bleed and square-cornered; the interface floats over it on gradient scrims, never in boxes.
- Two type voices: Antonio Variable capitals for what is read big (titles, dates, counts), the platform UI face for everything read small.
- Every label, tab and button is 11px uppercase tracked 0.14em.
- One outlined icon family; an "on" glyph fills rather than redraws.
- Accent appears only on live or engaged state; six user-selectable palettes share one structure.
- Flat by default; shadows only on things that genuinely float (dialogs, popovers, the selection bar).

## Colors

Six near-black palettes (Blood, Electric ultraviolet, Cobalt, Fuchsia, Deep indigo, Bone) share one token structure; the frontmatter records Blood, the default, and `src/shared/themes.ts` plus `src/renderer/index.css` hold all six and must stay in sync because the main process reads the same palette for the toast.

### Primary
- **Flash Red** (flash-red): the brand red and Blood's accent. It marks live and engaged state only: the pulsing REC and "Saving clip" dots, a starred glyph, a selected tile's 2px inset border and checkbox, an enabled toggle, the check beside a chosen dropdown option, editor trim handles. It is also the colour of the stickman logo in the title bar, the single place the accent appears as identity rather than state. Each theme swaps this value (ultraviolet #b45cff, cobalt #4d7cfe, fuchsia #ff4fa3, indigo #7c74ff, bone #f0f0f0) with a matching on-accent ink.
- **Red Wash / Red Line** (flash-red-wash, flash-red-line): 16% and 45% mixes of the accent, used as fill and border of the REC pill while the buffer runs and as the 3px ring around a trim handle being dragged.

### Secondary
- **Spark Amber** (spark): warnings that are advice, not failure: "your display runs at 60Hz", "use at least three syllables", the warn tone of capture health. Ultraviolet and indigo use a pink spark (#ff9ad0), bone a grey (#d6d6d6).

### Tertiary
- **Alert Rose** (alert-rose): errors and destructive intent: delete hover, danger buttons, a hotkey another program owns, save failures, the window close button's hover fill. On Blood it is a hot rose so an error can never be confused with the red REC state; on Fuchsia it deepens to #ff4d5e; the other themes use #ff6b6b.
- **Live Green** (live-green): the healthy-capture status dot. Identical on every theme because it is a status, not decoration.

### Neutral
- **Ground** (ground): the window, behind Library and Settings (with grain) and the title bar when it is not over media. Watch itself sits on pure #000 so letterboxing reads as the screen, not the app.
- **Panel** (panel): dialogs, dropdown menus, the floating selection bar, tile placeholders before a frame decodes.
- **Edge / Edge Soft** (edge, edge-soft): input strokes, scrollbars, popover borders, audio-lane tracks; edge-soft is the title bar's bottom rule and Library/Settings dividers.
- **Bone White** (bone-white): all primary text, every glyph, the solid button, the scrubber's played portion, focus outlines.
- **Ash ladder** (ash, ash-2, ash-3, ash-faint): secondary text, then tertiary metadata and resting tabs (ash-3), then tab counts (ash-faint). The ladder is mixed against the ground, so each step has the same contrast on every theme.
- **Hairline / Hairline Strong / Glass** (hairline, hairline-strong, glass): 30%, 70% and 7% white. The outline of buttons, keycaps, toggles and rail dividers; the hover/focus border; the hover fill.
- **Scrim** (scrim): the dense stop of every gradient that puts text over footage.

### Named Rules
**The Live-Only Accent Rule.** The theme accent marks something live, selected or engaged, and nothing else; resting chrome, headings, links and decoration are bone white or ash. The stickman logo is the one identity exception. Test: on a paused Watch screen with nothing starred, the only accent pixels are the logo and the REC dot.

**The Error Is Not Live Rule.** Alert is chosen per theme so it can never be read as the accent. Any new theme picks an alert at least as far from its accent as Blood's rose is from its red.

**The Mixed-Against-Ground Rule.** Derived neutral steps are `color-mix` against the ground, not against transparency, so a step's contrast does not depend on what it sits on. Overlay values (hairline, glass, washes) are the exception and are mixed against transparent on purpose.

## Typography

**Display Font:** Antonio Variable (bundled via @fontsource-variable/antonio; falls back to Bahnschrift SemiCondensed, Arial Narrow)
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui, Noto Sans, Cantarell, Ubuntu)

**Character:** A tall condensed poster capital for names, dates and numbers against a plain, native UI face for everything else. The UI face is the platform's own because Flash ships on Windows and Linux; only the display face is bundled.

### Hierarchy
- **Display Hero** (600, clamp(64px, 17vh, 168px), line-height 0.86; drops to clamp(48px, 9vh, 96px) above 14 characters): the clip title on Watch, low-left on the bottom scrim, with a 0 2px 30px shadow. Empty states use fixed 84 to 96px.
- **Headline** (600, 56px, 0.92): Library day headings (TODAY, YESTERDAY, 9 OCT) and the Settings page title. Storage total uses 48px, Library empty state 64px.
- **Title** (600, 30px, 0.92): dialog titles, the editor's Mix heading; Settings section headings step up to 40px with a hairline rule under them.
- **Title Small** (600, 22 to 26px): tile headings (24px), the editor header (24px), the Watch position counter and editor duration (26px), the selection bar count and theme-swatch dates (22px).
- **Body** (400, 13 to 15px, line-height 1.6, max 520 to 560px): dialog copy (13px), Settings row labels (14px), empty-state explanations (15px).
- **Body Small** (400, 12px, tabular numerals): metadata lines, timecodes, notes, Settings hints, storage footer.
- **Label** (600, 11px, 0.14em, uppercase): every button, tab, game name and status in the system; 10px in small buttons and tile game names, 10.5px in audio-lane names.

### Named Rules
**The Two Voices Rule.** Antonio is for words read at a distance (titles, dates, counts) and is always uppercase, weight 600, with tabular numerals. Everything read up close is the system face. Never set a paragraph, a button or a form value in Antonio.

**The Tracked Caps Rule.** Labels are 11px, weight 600, tracked 0.14em, uppercase, and go no smaller than 10px. Numbers in metadata use tabular figures so timecodes do not jitter while playing.

## Layout

Watch is absolute-positioned layers over a black stage: media at inset 0, a 140px top scrim carrying the 48px floating title bar, a bottom scrim covering 62% of the height, the caption block anchored 48px from the left and 64px from the bottom (title, then the tracked date line, then actions 26px below, then the game mark and metadata 22px below), the action rail vertically centred 28px from the right edge in 64px-wide columns, and the transport running edge to edge 40px in and 20px from the bottom.

Library is a filter bar over a scrolling grained surface: day groups with a 56px heading (36px top, 24px sides), then an `auto-fill, minmax(280px, 1fr)` grid of 16:9 tiles separated by a 2px seam and running to the window edges. Settings is a 168px sticky section rail beside one long scrolling column, 48px between sections. The Editor puts the preview left and a Mix column right, with the filmstrip and a bottom save bar spanning the full width.

Spacing is an 8/12/16/24 rhythm for gaps inside groups, 48px for page gutters on Watch and empty states, 24px inside Library and dialogs (28px dialog padding). There are no viewport breakpoints; display sizes scale with `vh` and the Library grid reflows by column count.

### Named Rules
**The Seam Not Gutter Rule.** Library tiles touch with a 2px seam and bleed to the window edges, a contact sheet rather than a card grid. Don't add padding, radius or gaps to make them cards.

## Elevation & Depth

Flat at rest. Depth comes from footage and darkness: gradient scrims (`rgba(4,4,6,0.95)` through the scrim token to transparent) under any text on media, soft text shadows on captions, a drop-shadow filter on rail glyphs so white outlines hold on bright frames, and a static 160px fractal-noise grain tile at 5% alpha on surfaces with no footage so they share the feed's material. Real box shadows appear only on elements that float above the page.

### Shadow Vocabulary
- **Dialog** (`box-shadow: 0 24px 64px rgba(0,0,0,0.6)`): confirm and identify-game dialogs over a 72% dark backdrop.
- **Floating bar / menu** (`box-shadow: 0 16px 40px rgba(0,0,0,0.6)`): dropdown menus and the multi-select bar.
- **Small popover** (`box-shadow: 0 12px 32px rgba(0,0,0,0.55)`): the selection bar's export and confirm popovers.
- **Glyph lift** (`filter: drop-shadow(0 1px 6px rgba(0,0,0,0.55))`): rail buttons over footage.
- **Caption lift** (`text-shadow: 0 1px 8px rgba(0,0,0,0.8)` for small text, `0 2px 30px rgba(0,0,0,0.45)` for the hero title).

### Named Rules
**The Scrim Not Card Rule.** Text over footage sits on a gradient scrim with a text shadow, never on a filled panel. The only filled shapes over media are small controls: 30px glyph circles at 55% black, the game-mark ring, a button's 35% black fill.

**The Shadow Means It Floats Rule.** A box shadow says "this is above the page and will go away". Nothing that is part of the layout gets one.

## Shapes

Media is square: feed video, Library tiles, the tile selection border. Controls are gently rounded at 6px (buttons, fields, dropdown triggers, the filmstrip, the tile checkbox), keycaps at 4px, popovers at 8px, dialogs and the selection bar at 10px. Circles and pills are reserved for things that are round by meaning: status dots, the REC pill, toggles, glyph chips, the game-mark ring, slider thumbs and tracks. Borders are 1px hairlines; the only 2px strokes are the selected tile (accent) and the focused tile (bone white), drawn inset. Joined controls (Export plus its size dropdown) square off their shared edge.

## Components

### Buttons
Outlined, tracked, quiet; the one filled button is the reason you are on the screen.
- **Shape:** gently rounded (6px), 34px tall, 16px sides; small variant 28px tall, 12px sides, 10px label.
- **Outline (default):** transparent with a 30% white hairline, bone-white label, optional 15px glyph 8px before the text.
- **Solid:** bone-white fill with ground-coloured label. One per action group: Edit clip on Watch, Save a copy in the Editor, the confirming action in a dialog.
- **Hover / Active:** hover adds 7% white glass and strengthens the hairline to 70%; press inverts to a white fill; 140ms ease on colour, border and background. Solid hover dims to 86% white. Disabled is 45% opacity.
- **Danger:** alert-rose label and 45% alert border, 12% alert fill on hover; solid danger fills with alert.
- **Ghost:** borderless outline variant for low-weight actions in bars.

### Navigation
- **Tabs:** text only, label type, ash-3 at rest, ash on hover, bone white when current with a 1px white underline flush to the baseline. Optional count in 10px ash-faint tabular figures. Used for top navigation (Watch, Library, Settings), game filters, sort order, editor speed and the Settings section rail.
- **Title bar:** 48px, transparent with no rule over media, ground with an edge-soft rule elsewhere. Logo and wordmark (Antonio 21px, 0.04em), tabs 24px apart, then status on the right: detected game, REC pill, hotkey keycap, and custom window controls (48px wide, close turns alert on hover).

### Action Rail (signature)
A vertical stack on Watch's right edge: one 30px outlined glyph (1.4 stroke) per action with a tracked label under it, 64px columns, 10px apart, then a hairline divider, previous/next chevrons and a big Antonio position counter over "of N". Glyphs scale to 1.08 on hover and 0.92 on press (160ms). Starred fills the glyph in the accent and plays the star pop, the one engaged moment that moves; Delete turns alert on hover.

### REC Pill
28px pill, label type. Idle: hairline border, hollow 8px ring, ash label "IDLE". Live: accent-wash fill, accent-line border, solid accent dot pulsing over 1.6s, bone-white "REC". Saving uses a 7px accent dot pulsing at 0.8s beside "SAVING CLIP".

### Inputs / Fields
- **Style:** hairline field, transparent, 1px edge stroke, 6px radius, 34px (search 32px), 12px text, ash-3 placeholder; over footage it takes a 50% black fill.
- **Focus:** border strengthens to 70% white; caret is the accent.
- **Hover:** border moves halfway toward ash.
- **Hotkey capture:** a 32px tabular button; listening shows a glass fill and white border, a key owned by another program shows alert text and border.
- **Error:** 12px alert text beneath.

### Toggles and Sliders
- **Toggle:** 36 by 20px pill. Off is a hairline outline with an ash knob; on fills with the accent and an on-accent knob (150ms).
- **Scrubber:** a native range, 3px track (5px on hover), played portion bone white over 22% white, 13px white thumb that appears on hover or focus with a 3px hairline-strong focus ring.
- **Gain slider:** 2px track, white fill over edge, 12px thumb, max 112px wide; used for volume, audio lanes and settings.

### Library Tile (signature)
16:9, square, panel placeholder, footage cover-fitted. A 62% bottom scrim carries a 24px Antonio heading and a 10px game label with duration. Hovering plays the clip silently and zooms it to 1.025 over 420ms. Star and delete glyph chips appear top-right on hover, focus or selection; a starred clip keeps a static accent star there. A 22px square checkbox appears top-left (accent fill with a check when selected). Selected draws a 2px inset accent border; keyboard focus draws a 2px inset white border.

### Dialogs, Menus and the Selection Bar
- **Dialog:** panel, 1px edge, 10px radius, 28px padding, 400 to 440px wide, title in 30px Antonio, 13px ash body, buttons right-aligned 8px apart with Cancel autofocused. Enters with an 8px rise and 0.985 scale over 160ms.
- **Dropdown:** 6px trigger in field style; menu is panel, 8px radius, 4px padding, 12px rows at 5px radius, hover row in the panel hover tone, the chosen row bone white with an accent check.
- **Selection bar:** floats centred 20px above the bottom of Library, panel with 10px radius, "N SELECTED" in 22px Antonio, small buttons, draggable as a whole into other apps.

### Keycap
22px, 4px radius, hairline border, ash 10.5px tabular text. Shows hotkeys in the title bar, empty states and the editor's in/out keys.

## Do's and Don'ts

### Do:
- **Do** give the current clip the whole window on pure black and layer the interface over it on gradient scrims.
- **Do** set titles, dates and counts in Antonio Variable, 600, uppercase, tabular numerals, line-height 0.86 to 0.92.
- **Do** set every label, tab and button in 11px weight-600 uppercase tracked 0.14em, never below 10px.
- **Do** draw icons from the one outlined family on a 24-unit grid at a 1.6 stroke (1.4 on the 30px rail); show "on" by filling the same glyph.
- **Do** keep the accent for live, selected and engaged state, and define a matching on-accent ink and a distinct alert for every theme.
- **Do** add new themes to both `src/shared/themes.ts` and `index.css`, with the full token set.
- **Do** put the static grain on any full-screen surface without footage.
- **Do** honour `prefers-reduced-motion`: the feed snap, caption rise, star pop, tile zoom and lane shimmer all switch off.

### Don't:
- **Don't** build a dark-dashboard card grid: no rounded, padded, shadowed cards for clips, stats or settings groups.
- **Don't** use the accent for headings, links, section rules, resting icons or decorative fills.
- **Don't** add neon glow, coloured shadows or angled HUD chrome; this must not read as an RGB gamer product.
- **Don't** put a filled panel behind caption text on footage; use the scrim and a text shadow.
- **Don't** set body copy, buttons or form values in Antonio, or bundle a second webfont for the UI face.
- **Don't** give a box shadow to anything that is part of the layout.
- **Don't** round media; tiles and video stay square-cornered.
- **Don't** put two solid buttons in the same group; the solid one is the thing you came to do.
