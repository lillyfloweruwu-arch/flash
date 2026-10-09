# UI redesign implementation and verification

Implemented on `ui-redesign`, without committing, against HEAD
`497a03c5fec467627828a65a55ba6a3a912f8b66`. Installed Electron: **44.7.0**.
The pre-existing `apps/desktop/.impeccable/hook.cache.json` modification was left alone.
No dependencies were added. Permanent deletion remains explicit. Capture continues
while the Flash window is hidden or minimized.

| Item | Implemented | Verified here | Still unverified |
|---|---|---|---|
| 1. Destructive dialog | Enter/Space use the focused button; one acceptance per mount; Escape cancels; focus is contained and restored. | Typecheck. Added a Chromium probe using real key events and disposable fixture files. | Chromium probe could not launch because of the local Electron directory ACL; keyboard and focus acceptance remain for the reviewer. |
| 2. Deletion | Per-path serialization distinguishes manual/prune intent. Every prune attempt rereads metadata and age/settings. Rename/move reject a path being deleted; starring remains available during retries. | Real Windows handle denied delete sharing. A star written after the first failed unlink protected the fixture after handle release. Manual deletion then succeeded. Unit checks cover exhausted retries, duplicate operations and mixed results. | Packaged bulk-delete UI presentation. |
| 3. Playback/decode | Main/preload visibility bridge starts conservatively hidden; Watch/Editor media pause on hide/minimize, audio contexts close, mix gain/mute edits survive hiding, and empty/hidden paths do not decode. Shared decode leases deduplicate, cancel queued work and bound work to one running plus one pending job. | Visibility service states and nine preload subscription cleanups pass. Queue stress: 102 requests produced two decodes, peak active one, final active zero. | Actual hidden/autostart audio, rapid long-clip browsing and process-memory settling. Queue measurements used controlled async jobs. |
| 4. Publication | Windows recording and PNG writers use `MediaOutput`; handles close before no-replace publication. Failure cleanup never removes a final destination. | Addon rebuilt. Native PNG reopens; existing PNG/MP4 bytes survive refused writes; injected writer failure leaves no published file or partial. Real capture clips exported/trimmed successfully; real screenshot decoded at 1920×1080. | Abrupt process termination during an actual save and packaged media scans during a write. |
| 5. Save outcomes | Refresh and saved metadata precede clipboard copy; copy rejection reports “saved to library.” Clip sidecars use the native save result's game. | Injected clipboard rejection leaves the PNG visible to refresh. Injected game change during disk checking yields matching result folder and sidecar. Native in-flight save identity probe also passes. | Actual clipboard paste/rejection in packaged Electron. |
| 6. State/settings | Tray/IPC/startup transitions use `setRecordingState`; resume immediately calls the watchdog. All hotkey changes refresh status. Display IDs and learned/ignored collections are sanitized; unavailable displays fall back before initialization. | Invalid-settings table, unavailable-display fallback, shared transition notifications, duplicate/conflicting secondary hotkeys and rebinding pass. Idle-reset hardware probe preserved 6.0s → 9.0s of buffer. | Real sleep/resume, display disconnect/recovery, shortcut conflicts and tray/overlay synchronization in the package. |
| 7. Dropdown | Popup is portaled outside scrolling ancestors, bounded to viewport space, scrolls active options into view, uses unique IDs and owns its handled keys/wheel events. | Typecheck. Chromium probe covers 60 options, 900×600, 150% zoom, reaching 300 seconds and preventing Watch navigation. | Chromium layout/mouse/keyboard acceptance, blocked by the Electron ACL. |
| 8. Ranges | Extracted strict single-range parser handles suffix/open-ended ranges, malformed requests and empty files. Protocol avoids creating an empty-file stream. | Byte-exact actual protocol responses for full/open/suffix/explicit requests, Unicode paths, empty 200 and malformed/unsatisfiable 416. | Real Electron seeking, sound and frame extraction against the packaged protocol. |
| 9. In-game surfaces | Extracted shared templates/tokens, near-black ground, white text, tracked labels, 8px popovers, live-dot-only accent and reduced motion. Antonio's 26,592-byte local woff2 is embedded at build time. Toast callbacks own their window; saving survives overlay readiness. DXGI coordinates map capture selection to Electron DIPs for corner placement. | Actual window functions with injected windows prove timer ownership and saving-state preservation. Rebuilt addon returns native display coordinates. One 1920×1080 monitor is attached. | Visual/font loading in built output, long names, all themes/corners, focus retention and multiple monitors. Chromium probe covers these where possible but could not launch. |
| 10. Routine probes only | Added safe sidecar, preload, main-boundary, Windows lock and native export-failure probes to `pnpm test`; native publication fixture joins native checks. Hardware checks are explicit through `FLASH_HARDWARE_TESTS=1`; absent-addon safe export and non-Windows lock checks skip cleanly. | **31 routine checks passed:** 15 TypeScript, five integration probes and 11 native checks. Hardware capture/export, screenshot and idle-reset probes were run separately and passed. | Fresh packaging and the complete Windows integration matrix belong to the reviewer. Linux build/runtime remain unverified. |

## Commands and decisive output

`pnpm typecheck` exited **0** after the final renderer changes.

The requested `cd packages/flash-capture; npx cmake-js build` failed before
compilation with `ERROR OMG spawn EPERM` in Visual Studio discovery. The addon
was then successfully rebuilt from the configured tree with
`cmake --build build --config Release --target flash_capture`:

```text
flash_capture.vcxproj -> C:\Users\emers\Downloads\Daddy Claude\Flash\packages\flash-capture\build\Release\flash_capture.node
```

The `.node` was not locked. No existing Electron process was killed to rebuild it.

The first routine run encountered the same output-pipe restriction. The runner
now inherits subprocess output (preserving probe measurements), and rebuilds
native tests directly with CMake instead of repeating Visual Studio discovery.
Final `pnpm test` exited **0**; its complete output is in
`scripts/probes/out/ui-redesign-tests.log` (ignored scratch output):

```text
PASS: 102 requests, 2 decodes, peak active 1, pending bounded to 1, active after completion 0
PASS: real Windows deny-delete handle; star during retry survives release; confirmed manual delete succeeds
PASS: safe native export/trim preserve existing bytes and failed outputs leave no partials
PASS: PNG reopens, existing PNG/MP4 unchanged, injected failure unpublished, no partials
all checks passed
```

Additional commands run:

```text
node --experimental-strip-types scripts/probes/export-and-game.js
PASS: pending save keeps Probe Game; next save is Unknown; audio restored to mixed
PASS: two exports coexist (1240978 and 1240978 bytes, budget 10485760)
PASS: failed exports preserve earlier copy and leave no partial or published file
PASS: measured oversize retries once, reports the budget error and removes the partial
PASS: repeated trims coexist and native trim refuses existing destinations

packages/flash-capture/build/Release/flash_screenshot_test.exe
screenshot self-check passed: 1920x1080 PNG decoded and is not uniformly black

node scripts/probes/reapply-settings.js
buffered before re-apply: 6.0s, after 3 re-applies + 3 s: 9.0s
PASS: re-applying settings kept the replay
```

`git diff --check` exited **0**.

`pnpm build` was attempted but failed in Vite's Windows real-path discovery with
`[commonjs--resolver] spawn EPERM`. This is **not** a successful renderer build or
packaging result. The isolated UI probe was attempted with:

```text
apps/desktop/node_modules/electron/dist/electron.exe scripts/probes/renderer-controls.js
FATAL: ... Sandboxed processes cannot read ... electron\dist ...
its ACL has an entry for an AppContainer package SID but none for ALL APPLICATION PACKAGES
```

Permissions were not changed. No visual, keyboard or packaged acceptance claim
is based on that failed launch. The reviewer should rerun this probe from a
working Electron installation, then exercise the fresh package's protocol,
shortcuts, tray, drag-and-drop, async clipboard, power events and clean shutdown.
