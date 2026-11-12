import { usePlaybackVisibility } from './usePlaybackVisibility'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { DEFAULT_THEME } from '../shared/themes'
import { DEFAULT_AUDIO_LANES } from '../shared/audioLanes'
import { clipUrl, matchesQuery } from '../shared/editor'
import type { AutostartState } from '../preload/preload'
import { clearSelection, selectRange, toggleSelection } from '../shared/selection'
import { SelectionBar } from './SelectionBar'
import Editor from './Editor'
import { FeedView } from './FeedView'
import { LibraryView, sortClips, type SortOrder } from './LibraryView'
import { SettingsView, type CaptureHealth, type Display, type Settings, type VoiceStatus } from './SettingsView'
import {
  type Clip, type ConfirmRequest, ConfirmDialog, IdentifyGamePrompt, StickmanIcon, formatBytes,
} from './ui'

/* THESIS: one clip owns the window and the next is one flick away; Flash
   refuses the dark-dashboard card grid every clipper ships.
   OWN-WORLD: near-black ground, white outlined glyphs, a soft bottom scrim,
   tall condensed Antonio capitals for titles, tracked small caps for labels,
   and the theme accent only on live or engaged state.
   STORY: open Flash, the newest moment is already playing; flick through,
   star the keepers, edit or export one, find the rest in the library.
   FIRST VIEWPORT: the latest clip full-bleed; game and huge title low-left
   with Edit / Grab frame / Export; action rail right; transport along the
   bottom edge; title bar floating over the top scrim.
   FORM: full-bleed vertical media feed (challenger, chosen by the owner),
   seed f314f4ea.
   FINISH: unreviewed and undocumented is unfinished; this build ends with the
   finish review, the verdict, and DESIGN.md */

type View = 'Feed' | 'Library' | 'Settings'
const VIEWS: View[] = ['Feed', 'Library', 'Settings']
// Shown names. "Feed" is the screen's form, but to a person it promises a
// social feed, and Flash has no account and posts nothing.
const VIEW_LABELS: Record<View, string> = { Feed: 'Watch', Library: 'Library', Settings: 'Settings' }

// ── Window Controls ───────────────────────────────────────────────────────────

// Drawn in React rather than via Electron's titleBarOverlay, which paints native
// buttons on top of whatever the app puts in its own top-right corner.
function WindowControls() {
  const Button = ({ label, onClick, path, danger }: { label: string; onClick: () => void; path: string; danger?: boolean }) => (
    <button aria-label={label} title={label} onClick={onClick}
      className="w-12 h-full flex items-center justify-center transition-colors"
      style={{ color: 'var(--muted)' }}
      onMouseEnter={e => {
        e.currentTarget.style.background = danger ? 'var(--alert)' : 'var(--glass)'
        e.currentTarget.style.color = danger ? 'white' : 'var(--fg)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--muted)'
      }}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  )

  return (
    <div className="flex items-stretch self-stretch titlebar-no-drag" style={{ marginRight: -20 }}>
      <Button label="Minimize" onClick={() => window.flash?.minimize()} path="M0 5h10" />
      <Button label="Maximize" onClick={() => window.flash?.maximize()} path="M0.5 0.5h9v9h-9z" />
      <Button label="Close to tray" onClick={() => window.flash?.close()} path="M0.5 0.5l9 9M9.5 0.5l-9 9" danger />
    </div>
  )
}

// ── Title bar ─────────────────────────────────────────────────────────────────

function TitleBar({ view, setView, overMedia, isRecording, onToggleRecording, detectedGame, captureAvailable, hotkey, saveState }: {
  view: View
  setView: (view: View) => void
  overMedia: boolean
  isRecording: boolean
  onToggleRecording: () => void
  detectedGame: string | null
  captureAvailable: boolean
  hotkey: string
  saveState: { saving: boolean; error?: string }
}) {
  return (
    <header className="absolute inset-x-0 top-0 z-30 flex items-center titlebar-drag"
      style={{
        height: 48, padding: '0 20px',
        background: overMedia ? 'transparent' : 'var(--bg)',
        borderBottom: overMedia ? '1px solid transparent' : '1px solid var(--edge-soft)',
      }}>
      <div className="flex items-center gap-2 titlebar-no-drag" style={{ marginRight: 36 }}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}><StickmanIcon size={20} /></span>
        <span className="display" style={{ fontSize: 21, color: 'var(--fg)', letterSpacing: '0.04em' }}>Flash</span>
      </div>

      <nav aria-label="Main" className="flex items-center gap-6 titlebar-no-drag">
        {VIEWS.map(name => (
          <button key={name} className="tab" aria-current={view === name ? 'page' : undefined}
            onClick={() => setView(name)}
            style={overMedia && view !== name ? { color: 'color-mix(in srgb, var(--fg) 62%, transparent)' } : undefined}>
            {VIEW_LABELS[name]}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-4 titlebar-no-drag">
        {saveState.saving && (
          <span role="status" className="flex items-center gap-2 caps" style={{ color: 'var(--fg)' }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--accent)', animation: 'pulse-red 0.8s ease-in-out infinite' }} />
            Saving clip
          </span>
        )}
        {saveState.error && !saveState.saving && (
          <span role="alert" title={saveState.error}
            style={{ fontSize: 12, color: 'var(--alert)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {saveState.error}
          </span>
        )}

        {detectedGame && (
          <span className="flex items-center gap-2 caps" style={{ color: 'var(--muted)' }} title="Game Flash is watching">
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--fg)' }} />
            {detectedGame}
          </span>
        )}

        <button onClick={onToggleRecording} disabled={!captureAvailable}
          className="flex items-center gap-2 caps transition-colors"
          aria-pressed={isRecording}
          title={captureAvailable ? (isRecording ? 'Replay buffer is running. Click to stop.' : 'Start the replay buffer') : 'Capture engine unavailable'}
          style={{
            height: 28, padding: '0 12px', borderRadius: 999,
            color: isRecording ? 'var(--fg)' : 'var(--muted)',
            border: `1px solid ${isRecording ? 'var(--accent-line)' : 'var(--line)'}`,
            background: isRecording ? 'var(--accent-wash)' : 'transparent',
            cursor: captureAvailable ? 'pointer' : 'not-allowed',
            opacity: captureAvailable ? 1 : 0.5,
          }}>
          <span aria-hidden="true" style={{
            width: 8, height: 8, borderRadius: 99,
            background: isRecording ? 'var(--accent)' : 'transparent',
            border: isRecording ? 'none' : '1.5px solid var(--muted)',
            animation: isRecording ? 'pulse-red 1.6s ease-in-out infinite' : 'none',
          }} />
          {isRecording ? 'Rec' : 'Idle'}
        </button>

        <span className="keycap" title="Clip hotkey">{hotkey}</span>

        <WindowControls />
      </div>
    </header>
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  usePlaybackVisibility()
  const [view, setView] = useState<View>('Feed')
  const [gameFilter, setGameFilter] = useState('All')
  const [starredOnly, setStarredOnly] = useState(false)
  const [clipQuery, setClipQuery] = useState('')
  const [sort, setSort] = useState<SortOrder>('Recent')
  const [feedPath, setFeedPath] = useState('')
  const [editingClip, setEditingClip] = useState<Clip | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [detectedGame, setDetectedGame] = useState<string | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const selectionAnchor = useRef<string | null>(null)
  const [storage, setStorage] = useState({ used: 0, clips: 0 })
  const [settings, setSettings] = useState<Settings>({
    clipsFolder: '', theme: DEFAULT_THEME, hotkey: 'F8', hotkeyShort: 'Shift+F8', screenshotHotkey: 'F9',
    shortClipSeconds: 15, displayId: 0, overlay: true, overlayPosition: 'top-left',
    voiceEnabled: false, voicePhrase: '', voiceRawFloor: 0.5, voiceCooldownMs: 3000,
    quality: '1080p 60fps', bufferLength: 30,
    audioCapture: true, audioLanes: DEFAULT_AUDIO_LANES, micDeviceId: '', autoSave: true, notifications: true, autoDeleteDays: 0,
    perGame: {},
  })
  const [encoder, setEncoder] = useState('none')
  const [captureBackend, setCaptureBackend] = useState('unknown')
  const [captureAvailable, setCaptureAvailable] = useState(false)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [autostart, setAutostart] = useState<AutostartState>(
    { enabled: false, managedByWindows: false, supported: false })
  // Re-read every time Settings is opened. Windows can have been changed
  // underneath us since the app started - Task Manager's Startup tab is one
  // click away - and a toggle showing a cached answer is a toggle that lies.
  useEffect(() => {
    if (view === 'Settings') window.flash?.getAutostart().then(setAutostart)
  }, [view])

  const toggleAutostart = useCallback(async () => {
    const next = await window.flash?.setAutostart(!autostart.enabled)
    if (next) setAutostart(next)
  }, [autostart.enabled])

  // All three keys, so a secondary hotkey lost to another app is visible in
  // Settings instead of looking fine and doing nothing.
  const [hotkeysRegistered, setHotkeysRegistered] = useState(
    { hotkey: '', clip: true, short: true, screenshot: true })
  const [identifyRequest, setIdentifyRequest] = useState<{ exe: string; suggested: string } | null>(null)
  const [health, setHealth] = useState<CaptureHealth | null>(null)
  const [learnedGames, setLearnedGames] = useState<Record<string, string>>({})
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    available: false,
    language: '',
    error: 'Checking voice activation…',
  })

  // Poll only while Settings is open — a background timer for a panel nobody is
  // looking at is exactly the kind of idle cost this app exists to avoid.
  const settingsPollBusy = useRef(false)
  useEffect(() => {
    if (view !== 'Settings' || !window.flash) return
    let cancelled = false
    const read = async () => {
      if (settingsPollBusy.current) return
      settingsPollBusy.current = true
      try {
        let captureStatus: any = null
        try {
          captureStatus = await window.flash!.capture.getStatus()
        } catch (error) {
          console.error('Could not read capture status', error)
        }
        const voice = await window.flash!.getVoiceStatus().catch(error => {
          console.error('Could not read voice status', error)
          return null
        })
        if (cancelled) return
        if (voice) setVoiceStatus(voice)
        if (!captureStatus) {
          setHealth({ healthy: false, fps: 0, buffered: 0, error: 'Capture unavailable' })
          return
        }
        const s: any = captureStatus
        setHealth({
          healthy: s.captureHealthy !== false && s.recording !== false,
          fps: s.lastIntervalMs > 0 ? 1000 / s.lastIntervalMs : 0,
          buffered: s.bufferSeconds ?? 0,
          audioMode: s.audioMode,
          error: s.captureError,
        })
        if (s.encoder) setEncoder(s.encoder)
        if (s.captureBackend) setCaptureBackend(s.captureBackend)
      } catch (error) {
        console.error('Could not read capture status', error)
        if (!cancelled) setHealth({ healthy: false, fps: 0, buffered: 0, error: 'Capture unavailable' })
      } finally {
        settingsPollBusy.current = false
      }
    }
    read()
    const timer = setInterval(read, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [view])
  const [displays, setDisplays] = useState<Display[]>([])
  const [saveState, setSaveState] = useState<{ saving: boolean; error?: string }>({ saving: false })

  // The theme is a data attribute on <html>; index.css keys every palette off it.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Save errors are transient — clear them rather than leaving a stale banner.
  useEffect(() => {
    if (!saveState.error) return
    const timer = setTimeout(() => setSaveState(s => ({ ...s, error: undefined })), 6000)
    return () => clearTimeout(timer)
  }, [saveState.error])

  const refreshClipsRequest = useRef(0)
  const refreshClips = useCallback(async () => {
    if (!window.flash) return
    const requestId = ++refreshClipsRequest.current
    try {
      const [clipList, storageInfo] = await Promise.all([
        window.flash.getClips(),
        window.flash.getStorage(),
      ])
      if (requestId !== refreshClipsRequest.current) return
      setClips(clipList)
      setStorage(storageInfo)
    } catch (error) {
      console.error('Could not refresh clips', error)
    }
  }, [])

  // Build game list from actual clips
  const games = Array.from(
    clips.reduce((map, clip) => {
      map.set(clip.game, (map.get(clip.game) ?? 0) + 1)
      return map
    }, new Map<string, number>())
  ).map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  const allGames = clips.length > 0 ? [{ name: 'All', count: clips.length }, ...games] : []

  // One list drives both the feed and the library, so the clip after this one
  // in the feed is the tile after it in the grid.
  const shownClips = useMemo(() => {
    const byGame = gameFilter === 'All' ? clips : clips.filter(c => c.game === gameFilter)
    const byStar = starredOnly ? byGame.filter(c => c.starred) : byGame
    const byQuery = clipQuery ? byStar.filter(clip => matchesQuery(clip, clipQuery)) : byStar
    return sortClips(byQuery, sort)
  }, [clips, gameFilter, starredOnly, clipQuery, sort])
  const filtered = gameFilter !== 'All' || starredOnly || clipQuery !== ''
  const filterLabel = [
    gameFilter === 'All' ? 'All games' : gameFilter,
    starredOnly ? 'Starred' : '',
    clipQuery ? `“${clipQuery}”` : '',
  ].filter(Boolean).join(' · ')
  const selectedClips = useMemo(() => clips.filter(clip => selectedIds.has(clip.id)), [clips, selectedIds])

  const clearFilters = useCallback(() => {
    setGameFilter('All'); setStarredOnly(false); setClipQuery('')
  }, [])

  const clearSelected = useCallback(() => {
    selectionAnchor.current = null
    setSelectedIds(clearSelection())
  }, [])

  const toggleSelected = useCallback((id: string) => {
    selectionAnchor.current = id
    setSelectedIds(selected => toggleSelection(selected, id))
  }, [])

  const selectDisplayedRange = useCallback((displayedIds: readonly string[], targetId: string) => {
    const previousAnchor = selectionAnchor.current
    const anchor = previousAnchor && displayedIds.includes(previousAnchor) ? previousAnchor : targetId
    if (anchor !== previousAnchor) selectionAnchor.current = anchor
    setSelectedIds(selected => selectRange(selected, displayedIds, anchor, targetId))
  }, [])

  const selectAllDisplayed = useCallback((displayedIds: readonly string[]) => {
    selectionAnchor.current = displayedIds[0] ?? null
    setSelectedIds(new Set(displayedIds))
  }, [])

  // A rename, delete or move changes IDs because IDs are paths. Drop only the
  // stale entries; filtering the grid does not discard a deliberate selection.
  useEffect(() => {
    const liveIds = new Set(clips.map(clip => clip.id))
    if (selectionAnchor.current && !liveIds.has(selectionAnchor.current)) selectionAnchor.current = null
    setSelectedIds(selected => {
      const next = new Set([...selected].filter(id => liveIds.has(id)))
      return next.size === selected.size ? selected : next
    })
  }, [clips])

  const updateSettings = useCallback(async (partial: Partial<Settings>) => {
    if (!window.flash) return
    const updated = await window.flash.setSettings(partial)
    setSettings(updated)
    if (partial.clipsFolder) refreshClips()
    // A rebind can fail if another program already owns the key.
    if (partial.hotkey !== undefined || partial.hotkeyShort !== undefined || partial.screenshotHotkey !== undefined) {
      const status = await window.flash.getHotkeyStatus()
      setHotkeysRegistered(status)
    }
    if (partial.voiceEnabled !== undefined || partial.voicePhrase !== undefined
      || partial.voiceRawFloor !== undefined || partial.voiceCooldownMs !== undefined) {
      setVoiceStatus(await window.flash.getVoiceStatus())
    }
  }, [refreshClips])

  // Confirmation lives here so the feed and the library get the same dialog
  // without either of them knowing it exists.
  const deleteClip = useCallback((clip: Clip) => {
    setConfirmRequest({
      title: 'Delete this clip?',
      body: `"${clip.title}" (${clip.game}, ${formatBytes(clip.size)}) will be permanently deleted from disk.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        const result = await window.flash?.deleteClip(clip.filePath)
        // A failed delete used to be silent and the clip just stayed put.
        if (result?.error) setSaveState(state => ({ ...state, error: result.error! }))
        else if (!result?.deleted) setSaveState(state => ({ ...state, error: `Could not delete "${clip.title}". It may be open in another program.` }))
        refreshClips()
      },
    })
  }, [refreshClips])

  const deleteSelection = useCallback(() => {
    const selection = [...selectedClips]
    const count = selection.length
    if (!count) return
    const itemWord = count === 1 ? 'item' : 'items'
    const size = selection.reduce((total, clip) => total + clip.size, 0)
    setConfirmRequest({
      title: `Delete ${count} ${itemWord}?`,
      body: `${count} selected ${itemWord} (${formatBytes(size)}) will be permanently deleted from disk.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        const results = await Promise.allSettled(selection.map(clip => window.flash?.deleteClip(clip.filePath)))
        const failed = results.filter(result => result.status === 'rejected' || !result.value?.deleted)
        if (failed.length) {
          const reason = failed
            .map(result => result.status === 'fulfilled' ? result.value?.error : undefined)
            .find((message): message is string => !!message)
          setSaveState(state => ({ ...state, error: reason || `Could not delete ${failed.length} of ${count} ${itemWord}.` }))
        }
        clearSelected()
        await refreshClips()
      },
    })
  }, [clearSelected, refreshClips, selectedClips])

  // Written to the clip's sidecar, so the answer survives a settings reset and
  // travels with the file. The list is updated optimistically because the round
  // trip is a small file write and a flicker on a star is worse than a stale one.
  const starClip = useCallback(async (clip: Clip) => {
    const next = !clip.starred
    setClips(current => current.map(c => c.filePath === clip.filePath ? { ...c, starred: next } : c))
    const result = await window.flash?.setClipStarred(clip.filePath, next)
    if (!result || result.error) {
      setClips(current => current.map(c => c.filePath === clip.filePath ? { ...c, starred: clip.starred } : c))
    }
  }, [])

  const renameClip = useCallback(async (clip: Clip, name: string) => {
    if (!window.flash) return 'Rename is unavailable'
    const result = await window.flash.renameClip(clip.filePath, name)
    if (result.error) return result.error
    await refreshClips()
    return null
  }, [refreshClips])

  const toggleRecording = useCallback(async () => {
    if (!window.flash) return
    if (isRecording) await window.flash.capture.stopReplayBuffer()
    else await window.flash.capture.startReplayBuffer()
  }, [isRecording])

  // A freshly saved clip goes to the top of the feed, so the moment you just
  // kept is the one playing when you look over.
  const lastClipCount = useRef(0)
  useEffect(() => {
    if (clips.length > lastClipCount.current && lastClipCount.current > 0 && view === 'Feed' && sort === 'Recent' && !filtered) {
      const newest = shownClips[0]
      if (newest) setFeedPath(newest.filePath)
    }
    lastClipCount.current = clips.length
  }, [clips.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!window.flash) return

    const unsubscribe: (() => void)[] = []
    unsubscribe.push(window.flash.onRecordingState(setIsRecording))
    unsubscribe.push(window.flash.onNavigate((target: string) => setView(target === 'Settings' ? 'Settings' : target === 'Feed' ? 'Feed' : 'Library')))
    window.flash.getRecordingState().then(setIsRecording)
    window.flash.getSettings().then(setSettings)
    window.flash.getVoiceStatus().then(setVoiceStatus)
    window.flash.getHotkeyStatus().then(setHotkeysRegistered)
    window.flash.getAutostart().then(setAutostart)
    window.flash.capture.listDisplays().then(setDisplays)
    unsubscribe.push(window.flash.capture.onSaveState(setSaveState))
    unsubscribe.push(window.flash.onIdentifyGame(setIdentifyRequest))
    window.flash.getLearnedGames().then(setLearnedGames)
    window.flash.hasCaptureAddon().then(setCaptureAvailable)
    window.flash.capture.getStatus().then(s => { setEncoder(s.encoder); if (s.captureBackend) setCaptureBackend(s.captureBackend) })
    unsubscribe.push(window.flash.onGameDetected(setDetectedGame))
    window.flash.getCurrentGame().then(setDetectedGame)
    unsubscribe.push(window.flash.onClipSavedRefresh(() => refreshClips()))

    // Served over flash-clip, not file://. A renderer page on
    // http://localhost:5173 cannot load file:// media, so in development the
    // sound silently never played - and the empty catch below hid it.
    unsubscribe.push(window.flash.onPlayClipSound((soundPath: string) => {
      const audio = new Audio(clipUrl(soundPath))
      audio.volume = 0.7
      audio.play().catch(error => console.warn('Could not play the clip sound', error))
    }))

    refreshClips()
    return () => { unsubscribe.forEach(remove => remove()) }
  }, [refreshClips])

  const emptyHint = !captureAvailable
    ? 'The capture engine is unavailable. Check that the native addon is built.'
    : isRecording
      ? <>Flash is holding the last {settings.bufferLength} seconds. Press <span className="keycap" style={{ color: 'var(--fg)' }}>{settings.hotkey}</span> in game to keep them.</>
      : <>Start the replay buffer from the Idle button above, then press <span className="keycap" style={{ color: 'var(--fg)' }}>{settings.hotkey}</span> in game.</>

  return (
    <div className="relative" style={{ width: '100vw', height: '100vh', background: 'var(--bg)', overflow: 'hidden' }}>
      <TitleBar
        view={view} setView={setView} overMedia={view === 'Feed' && !editingClip}
        isRecording={isRecording} onToggleRecording={toggleRecording}
        detectedGame={detectedGame} captureAvailable={captureAvailable}
        hotkey={settings.hotkey} saveState={saveState}
      />

      {/* The feed is unmounted while the editor is open, not just covered by
          it. Left mounted, its <video> keeps playing underneath and its key
          listener steals the arrow keys from the editor's own scrubbing. */}
      {view === 'Feed' && !editingClip && (
        <FeedView
          clips={shownClips}
          currentPath={feedPath}
          onPathChange={setFeedPath}
          filterLabel={filterLabel}
          filtered={filtered}
          onClearFilters={clearFilters}
          onOpenLibrary={() => setView('Library')}
          onDelete={deleteClip}
          onEdit={setEditingClip}
          onRename={renameClip}
          onStar={starClip}
          isRecording={isRecording} captureAvailable={captureAvailable}
          hotkey={settings.hotkey} bufferLength={settings.bufferLength}
          onToggleRecording={toggleRecording}
        />
      )}

      {/* Kept mounted while hidden so the scroll position survives a trip to
          the feed; hidden tiles fall out of view and release their decoders. */}
      <main className="absolute inset-0 flex flex-col grain" style={{ top: 48, display: view === 'Library' ? 'flex' : 'none' }}>
        <LibraryView
          clips={shownClips}
          games={allGames} gameFilter={gameFilter} setGameFilter={setGameFilter}
          starredOnly={starredOnly} setStarredOnly={setStarredOnly}
          starredCount={clips.filter(c => c.starred).length}
          sort={sort} setSort={setSort}
          query={clipQuery} onQueryChange={setClipQuery}
          storage={storage} onOpenFolder={() => window.flash?.openClipsFolder()}
          shortcutsEnabled={view === 'Library' && editingClip === null}
          selectedIds={selectedIds}
          onToggleSelection={toggleSelected}
          onSelectRange={selectDisplayedRange}
          onSelectAll={selectAllDisplayed}
          onClearSelection={clearSelected}
          onOpenClip={clip => { setFeedPath(clip.filePath); setView('Feed') }}
          onDeleteClip={deleteClip}
          onStarClip={starClip}
          suspendThumbnails={editingClip !== null}
          emptyHint={emptyHint}
        />
        {selectedClips.length > 0 && (
          <SelectionBar
            items={selectedClips}
            games={games.map(game => game.name)}
            onClear={clearSelected}
            onDelete={deleteSelection}
            onRefresh={refreshClips}
          />
        )}
      </main>

      {view === 'Settings' && (
        <main className="absolute inset-0 flex flex-col" style={{ top: 48 }}>
          <SettingsView
            previewClip={clips.filter(clip => clip.kind !== 'shot').sort((x, y) => y.createdAt - x.createdAt)[0]?.filePath}
            settings={settings} onChange={updateSettings} storage={storage} encoder={encoder}
            captureBackend={captureBackend}
            voiceStatus={voiceStatus}
            hotkeysRegistered={hotkeysRegistered} autostart={autostart} onToggleAutostart={toggleAutostart}
            displays={displays} health={health}
            learnedGames={learnedGames}
            onForgetGame={async exe => setLearnedGames(await window.flash!.forgetGame(exe))}
            onOpenFolder={() => window.flash?.openClipsFolder()}
            onPickFolder={async () => {
              const folder = await window.flash?.pickClipsFolder()
              if (folder) { setSettings(s => ({ ...s, clipsFolder: folder })); refreshClips() }
            }}
          />
        </main>
      )}

      {editingClip && (
        <Editor clip={editingClip} onClose={() => setEditingClip(null)} />
      )}
      {confirmRequest && (
        <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />
      )}
      {identifyRequest && (
        <IdentifyGamePrompt request={identifyRequest} onClose={name => {
          window.flash?.identifyGame(identifyRequest.exe, name)
          setIdentifyRequest(null)
        }} />
      )}
    </div>
  )
}
