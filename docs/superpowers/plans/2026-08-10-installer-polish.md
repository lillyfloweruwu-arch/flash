# Installer polish — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Flash's setup wizard look like Flash rather than like stock NSIS.

**Architecture:** electron-builder's NSIS target already produces an assisted wizard. It stays assisted — the win is branding it and removing the confusing per-machine prompt, not replacing the installer framework.

**Scheduling:** after the clip editor is complete (renderer plan Tasks 4–6). The installer is the front door; polishing it before the room behind it is finished is the wrong order. Nothing here depends on the editor, so it can move earlier if wanted.

## Global constraints

- **No new dependencies and no new installer framework.** This is `nsis` config plus image assets. Do not reach for WiX, MSIX, Squirrel, or Inno.
- Brand colours come from the app's own theme, not invented ones: default accent `#c1121f`, background `#0c0607`, panel `#1c0e11`, foreground `#fff0f1` (see `apps/desktop/src/renderer/index.css`).
- The existing icon is `assets/icons/blood.ico`. The stickman logo lives as an inline SVG in `App.tsx` (`StickmanIcon`) — reuse that mark rather than drawing a new one.
- NSIS wants **BMP** for header and sidebar images. PNG will silently not apply.

## What is wrong today

From `apps/desktop/package.json`:

- No `installerHeader`, no `installerSidebar`, no `uninstallerSidebar`. Every page shows the default NSIS grey with the stock header strip.
- `perMachine: false` while an existing per-machine install is present produces the "There is already a per-machine installation (C:\Program Files\Flash). Will reinstall/upgrade." notice on the install-scope page. It is accurate and it looks like an error.
- No license page, no finish-page "run Flash" affordance.
- Window title is "Flash Setup", which is fine, but the wizard carries no version anywhere prominent.

---

## Task 1: Brand assets

**Files:**
- Create: `assets/installer/header.bmp` — 150×57, 24-bit
- Create: `assets/installer/sidebar.bmp` — 164×314, 24-bit
- Create: `assets/installer/sidebar-uninstall.bmp` — 164×314, 24-bit

- [ ] **Step 1: Generate them**

Both are flat brand panels, not photographs: background `#0c0607`, the stickman mark in `#c1121f`, wordmark in `#fff0f1`. The sidebar carries the mark and "Flash" vertically centred in the upper third; the header carries a small mark on the left of the strip.

Generate with a script rather than by hand so they can be regenerated when the brand moves. Any existing image tooling in the repo is fine; if none fits, a small Node script writing a 24-bit BMP directly is about forty lines and adds no dependency.

BMP has no alpha, so match the background exactly to the NSIS page colour set in Task 2, or the images will show a visible box.

- [ ] **Step 2: Verify dimensions and depth**

Wrong dimensions are silently letterboxed and 32-bit BMPs render with a black box on some Windows versions. Confirm each file is exactly its target size and 24-bit before moving on.

- [ ] **Step 3: Commit**

```bash
git add assets/installer
git commit -m "assets: installer header and sidebar artwork"
```

---

## Task 2: Wire the branding into electron-builder

**Files:**
- Modify: `apps/desktop/package.json` (the `build.nsis` block)

- [ ] **Step 1: Point NSIS at the assets**

Add to `build.nsis`:

```json
"installerHeader": "../../assets/installer/header.bmp",
"installerSidebar": "../../assets/installer/sidebar.bmp",
"uninstallerSidebar": "../../assets/installer/sidebar-uninstall.bmp",
"installerIcon": "../../assets/icons/blood.ico",
"uninstallerIcon": "../../assets/icons/blood.ico",
"uninstallDisplayName": "Flash ${version}"
```

- [ ] **Step 2: Stop the per-machine warning**

The notice appears because the build declares `perMachine: false` while an install exists under `C:\Program Files`. Set `perMachine: true` so the scope is consistent with where it already installs, and drop the install-scope page entirely — it is a question with one sensible answer for a single-user desktop capture tool.

Keep `allowToChangeInstallationDirectory: true`. Choosing a folder is a real choice; choosing an install scope is not.

- [ ] **Step 3: Offer to launch on finish**

Add `"runAfterFinish": true` so the finish page has a checkbox rather than dead-ending.

- [ ] **Step 4: Build and look at it**

```bash
pnpm --filter "@flash/desktop" run package
```

Run `release/Flash Setup <version>.exe` and confirm: branded sidebar on the welcome and finish pages, branded header strip on the rest, the app icon in the title bar and taskbar, no per-machine notice, and the finish page offering to launch Flash.

Uninstall from Windows Settings and confirm the uninstaller carries its own sidebar and shows "Flash <version>".

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json
git commit -m "build: brand the setup wizard and drop the install-scope page"
```

---

## Definition of done

- Welcome and finish pages carry the Flash sidebar; interior pages carry the branded header.
- No "there is already a per-machine installation" notice on a clean upgrade.
- The finish page can launch the app.
- The uninstaller is branded and names its version.
- No new dependency in `package.json`.
