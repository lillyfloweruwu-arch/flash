import { useEffect, useRef, useState } from 'react'
import { clipUrl } from '../shared/editor'
import { THEMES } from '../shared/themes'
import { toAccelerator } from '../shared/accelerator'
import { resolveGameSettings } from '../shared/perGame'
import { countSyllables } from '../shared/syllables'
import type { AutostartState } from '../preload/preload'
import { Dropdown } from './Dropdown'
import { Toggle, formatBytes } from './ui'

export interface Settings {
  clipsFolder: string
  theme: string
  hotkey: string
  hotkeyShort: string
  screenshotHotkey: string
  shortClipSeconds: number
  voiceEnabled: boolean
  voicePhrase: string
  voiceRawFloor: number
  voiceCooldownMs: number
  displayId: number
  overlay: boolean
  overlayPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  quality: string
  bufferLength: number
  audioCapture: boolean
  autoSave: boolean
  notifications: boolean
  autoDeleteDays: number
  perGame: Record<string, { quality?: string; bufferLength?: number }>
}

export interface Display {
  id: number
  name: string
  width: number
  height: number
  isPrimary: boolean
  refreshHz?: number
}

export interface CaptureHealth {
  healthy: boolean
  fps: number
  buffered: number
  audioMode?: string
  error?: string
}

export interface VoiceStatus {
  available: boolean
  language: string
  error: string
}

// Ordered by how much they cost, not by resolution, so the list reads as a
// single ladder. High frame rates are only worth offering because capture can
// actually reach them - the ceiling is the display's refresh rate.
const QUALITY_OPTIONS = [
  '720p 30fps', '720p 60fps',
  '1080p 30fps', '1080p 60fps', '1080p 120fps', '1080p 144fps',
  '1440p 60fps', '1440p 120fps',
  '4K 30fps', '4K 60fps',
]

function qualityFps(quality: string): number {
  const match = /(\d+)fps$/.exec(quality.trim())
  return match ? Number(match[1]) : 0
}

// One still from a real clip, so each theme is previewed over actual footage
// rather than an empty box. Decoded once into a small JPEG and the decoder is
// released straight away.
function useClipStill(filePath: string | undefined): string | null {
  const [still, setStill] = useState<string | null>(null)
  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    const release = () => { video.removeAttribute('src'); video.load() }
    video.addEventListener('seeked', () => {
      if (cancelled) return
      const canvas = document.createElement('canvas')
      canvas.width = 384
      canvas.height = 216
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      try { setStill(canvas.toDataURL('image/jpeg', 0.8)) } catch { /* tainted or empty: keep the plain swatch */ }
      release()
    }, { once: true })
    video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(1, video.duration / 2 || 0) }, { once: true })
    video.src = clipUrl(filePath)
    return () => { cancelled = true; release() }
  }, [filePath])
  return still
}

const SECTIONS = ['Appearance', 'Capture', 'Voice', 'Games', 'Overlay', 'Storage'] as const

// ── Pieces ────────────────────────────────────────────────────────────────────

// Defined at module scope on purpose. Declared inside SettingsView these were
// a new component type on every render, so React tore the whole settings tree
// down and built it again - and the status poll re-renders every two seconds.
// Anything holding its own state below a Row lost it on that tick.
function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6" style={{ padding: '16px 0', borderBottom: '1px solid var(--edge-soft)' }}>
      <div className="min-w-0">
        <div style={{ fontSize: 14, color: 'var(--fg)' }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-3">{children}</div>
    </div>
  )
}

function Section({ id, title, children, sectionRef }: {
  id: string
  title: string
  children: React.ReactNode
  sectionRef: (node: HTMLElement | null) => void
}) {
  return (
    <section id={`settings-${id}`} ref={sectionRef} aria-labelledby={`settings-${id}-title`} style={{ paddingTop: 48 }}>
      <h2 id={`settings-${id}-title`} className="display" style={{ fontSize: 40, color: 'var(--fg)', paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Status({ tone, children, title }: { tone: 'ok' | 'warn' | 'bad' | 'plain'; children: React.ReactNode; title?: string }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--spark)' : tone === 'bad' ? 'var(--alert)' : 'var(--muted)'
  return (
    <span title={title} className="flex items-center gap-2 tabular" style={{ fontSize: 13, color: tone === 'plain' ? 'var(--muted)' : 'var(--fg)' }}>
      {tone !== 'plain' && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, background: color }} />}
      {children}
    </span>
  )
}

function Range({ value, min, max, step, onChange, label, suffix }: {
  value: number; min: number; max: number; step: number; onChange: (value: number) => void; label: string; suffix: string
}) {
  const filled = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <>
      <span className="display" style={{ fontSize: 22, color: 'var(--fg)', minWidth: 48, textAlign: 'right' }}>{value}{suffix}</span>
      <input type="range" className="audio-gain-range" aria-label={label}
        min={min} max={max} step={step} value={value}
        onChange={event => onChange(+event.target.value)}
        style={{ width: 160, ['--filled' as string]: `${filled}%` }} />
    </>
  )
}

function HotkeyInput({ value, registered, onChange, label }: {
  value: string
  registered: boolean
  onChange: (accelerator: string) => void
  label: string
}) {
  const [listening, setListening] = useState(false)

  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setListening(false); return }
      const accelerator = toAccelerator(e)
      if (!accelerator) return   // keep listening through bare modifiers
      onChange(accelerator)
      setListening(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, onChange])

  const failed = !registered && !listening
  return (
    <button type="button" onClick={() => setListening(l => !l)} aria-label={`${label}: ${value}. Click to change`}
      title={failed ? 'Another program already owns this key. Pick a different one.' : 'Click, then press a key'}
      className="tabular transition-colors"
      style={{
        height: 32, minWidth: 112, padding: '0 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
        color: listening ? 'var(--fg)' : failed ? 'var(--alert)' : 'var(--fg)',
        background: listening ? 'var(--glass)' : 'transparent',
        border: `1px solid ${listening ? 'var(--fg)' : failed ? 'var(--alert)' : 'var(--line)'}`,
      }}>
      {listening ? 'Press a key…' : failed ? `${value} is taken` : value}
    </button>
  )
}

// ── View ──────────────────────────────────────────────────────────────────────

export function SettingsView({ previewClip, settings, onChange, storage, encoder, captureBackend, voiceStatus, hotkeysRegistered, autostart, onToggleAutostart, displays, health, learnedGames, onForgetGame, onOpenFolder, onPickFolder }: {
  previewClip?: string
  settings: Settings
  onChange: (partial: Partial<Settings>) => void
  storage: { used: number; clips: number }
  encoder: string
  captureBackend: string
  voiceStatus: VoiceStatus
  hotkeysRegistered: { clip: boolean; short: boolean; screenshot: boolean }
  autostart: AutostartState
  onToggleAutostart: () => void
  displays: Display[]
  health: CaptureHealth | null
  learnedGames: Record<string, string>
  onForgetGame: (exe: string) => void
  onOpenFolder: () => void
  onPickFolder: () => void
}) {
  // The ceiling for a useful frame rate is the refresh rate of the display
  // actually being captured, not the fastest one attached.
  const activeRefreshHz = displays.find(d => d.id === settings.displayId)?.refreshHz ?? 0
  const customPhraseSyllables = countSyllables(settings.voicePhrase)
  const customPhraseTooShort = settings.voicePhrase.trim().length > 0 && customPhraseSyllables < 3

  const still = useClipStill(previewClip)
  const scroller = useRef<HTMLDivElement>(null)
  const sectionNodes = useRef<Record<string, HTMLElement | null>>({})
  const [current, setCurrent] = useState<string>(SECTIONS[0])

  // The index follows the reading position.
  useEffect(() => {
    const root = scroller.current
    if (!root) return
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (visible) setCurrent(visible.target.id.replace('settings-', ''))
    }, { root, rootMargin: '0px 0px -65% 0px' })
    Object.values(sectionNodes.current).forEach(node => node && observer.observe(node))
    return () => observer.disconnect()
  }, [])

  const updateGameOverride = (
    game: string,
    field: 'quality' | 'bufferLength',
    value: string | number | undefined,
  ) => {
    const perGame = { ...settings.perGame }
    const override = { ...perGame[game] }
    if (field === 'quality') {
      if (value === undefined) delete override.quality
      else override.quality = String(value)
    } else {
      if (value === undefined) delete override.bufferLength
      else override.bufferLength = Number(value)
    }
    if (Object.keys(override).length) perGame[game] = override
    else delete perGame[game]
    onChange({ perGame })
  }

  const register = (id: string) => (node: HTMLElement | null) => { sectionNodes.current[id] = node }

  return (
    <div ref={scroller} className="flex-1 overflow-y-auto grain">
      <div className="flex mx-auto" style={{ maxWidth: 1080, padding: '0 40px 96px', gap: 64 }}>
        <nav aria-label="Settings sections" className="shrink-0" style={{ width: 168, position: 'sticky', top: 0, alignSelf: 'flex-start', paddingTop: 56 }}>
          <h1 className="display" style={{ fontSize: 56, color: 'var(--fg)', marginBottom: 28 }}>Settings</h1>
          <ul className="flex flex-col" style={{ gap: 4 }}>
            {SECTIONS.map(section => (
              <li key={section}>
                <button className="tab" aria-current={current === section ? 'page' : undefined}
                  onClick={() => sectionNodes.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  {section}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex-1 min-w-0" style={{ paddingTop: 8 }}>
          <Section id="Appearance" title="Appearance" sectionRef={register('Appearance')}>
            <div className="grid" style={{ gap: 12, paddingTop: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {Object.entries(THEMES).map(([key, theme]) => {
                const selected = settings.theme === key
                return (
                  <button key={key} onClick={() => onChange({ theme: key })} aria-pressed={selected}
                    className="flex flex-col text-left" style={{ gap: 10 }}>
                    {/* The Watch screen in that palette: your latest clip under
                        the theme's scrim, its title, and the accent where it
                        actually appears - the REC light and the progress bar. */}
                    <span className="relative block w-full overflow-hidden"
                      style={{
                        aspectRatio: '16 / 10', borderRadius: 8, background: theme.bg,
                        outline: selected ? '2px solid var(--fg)' : `1px solid ${theme.edge}`, outlineOffset: selected ? 2 : 0,
                      }}>
                      {still && <img src={still} alt="" className="absolute inset-0 w-full h-full object-cover" />}
                      <span className="absolute inset-0" style={{ background: `linear-gradient(to top, ${theme.bg} 8%, ${theme.bg}99 45%, transparent 80%)` }} />
                      <span className="absolute flex items-center" style={{ left: 8, top: 8, gap: 4, padding: '2px 6px', borderRadius: 99, background: `${theme.bg}b3` }}>
                        <span style={{ width: 6, height: 6, borderRadius: 99, background: theme.accent }} />
                        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color: theme.fg }}>REC</span>
                      </span>
                      <span className="absolute display" style={{ left: 10, bottom: 16, fontSize: 22, color: theme.fg }}>9 Oct</span>
                      <span className="absolute" style={{ left: 0, right: 0, bottom: 0, height: 4, background: `${theme.fg}33` }}>
                        <span className="absolute" style={{ left: 0, top: 0, bottom: 0, width: '45%', background: theme.accent }} />
                      </span>
                    </span>
                    <span className="caps" style={{ color: selected ? 'var(--fg)' : 'var(--muted)' }}>{theme.label}</span>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section id="Capture" title="Capture" sectionRef={register('Capture')}>
            <Row label="Clip hotkey" hint={`Saves the full ${settings.bufferLength} seconds.`}>
              <HotkeyInput label="Clip hotkey" value={settings.hotkey} registered={hotkeysRegistered.clip}
                onChange={hotkey => onChange({ hotkey })} />
            </Row>
            <Row label="Short clip hotkey" hint={`Saves only the last ${Math.min(settings.shortClipSeconds, settings.bufferLength)} seconds.`}>
              <HotkeyInput label="Short clip hotkey" value={settings.hotkeyShort} registered={hotkeysRegistered.short}
                onChange={hotkeyShort => onChange({ hotkeyShort })} />
            </Row>
            <Row label="Screenshot hotkey">
              <HotkeyInput label="Screenshot hotkey" value={settings.screenshotHotkey} registered={hotkeysRegistered.screenshot}
                onChange={screenshotHotkey => onChange({ screenshotHotkey })} />
            </Row>
            <Row label="Buffer length" hint="How far back a full clip reaches. Longer costs more memory.">
              <Range label="Buffer length" value={settings.bufferLength} min={10} max={300} step={5} suffix="s"
                onChange={bufferLength => onChange({ bufferLength })} />
            </Row>
            {/* A short clip cannot be longer than the buffer it is cut from. */}
            <Row label="Short clip length">
              <Range label="Short clip length" value={Math.min(settings.shortClipSeconds, settings.bufferLength)}
                min={5} max={Math.max(5, settings.bufferLength)} step={5} suffix="s"
                onChange={shortClipSeconds => onChange({ shortClipSeconds })} />
            </Row>
            {displays.length > 1 && (
              <Row label="Capture display">
                <Dropdown
                  value={settings.displayId}
                  onChange={displayId => onChange({ displayId })}
                  width={230}
                  options={displays.map(d => ({
                    value: d.id,
                    label: `Display ${d.id + 1}: ${d.width}x${d.height}`,
                    hint: [d.refreshHz ? `${d.refreshHz}Hz` : '', d.isPrimary ? 'primary' : '']
                      .filter(Boolean).join(' · ') || undefined,
                  }))}
                />
              </Row>
            )}
            <Row label="Quality"
              hint={activeRefreshHz > 0 && qualityFps(settings.quality) > activeRefreshHz
                ? <span style={{ color: 'var(--spark)' }}>Your display runs at {activeRefreshHz}Hz, so frames above that are duplicates.</span>
                : undefined}>
              <Dropdown
                value={settings.quality}
                onChange={quality => onChange({ quality })}
                options={QUALITY_OPTIONS.map(q => ({
                  value: q,
                  label: q,
                  hint: activeRefreshHz > 0 && qualityFps(q) > activeRefreshHz ? 'over refresh' : undefined,
                }))}
                width={170}
              />
            </Row>
            <Row label="Record audio" hint="Game, system and microphone, each on its own track.">
              <Toggle label="Record audio" on={settings.audioCapture} onChange={() => onChange({ audioCapture: !settings.audioCapture })} />
            </Row>
            {autostart.supported && (
              <Row label={window.flash.platform === 'win32' ? 'Start with Windows' : 'Start with your computer'}
                hint={autostart.managedByWindows
                  ? <span style={{ color: 'var(--alert)' }}>Turned off in Windows. Re-enable Flash under Startup apps in Task Manager.</span>
                  : autostart.error ? <span style={{ color: 'var(--alert)' }}>{autostart.error}</span> : undefined}>
                <Toggle label={window.flash.platform === 'win32' ? 'Start with Windows' : 'Start with your computer'} on={autostart.enabled} onChange={onToggleAutostart} />
              </Row>
            )}
            <Row label="Encoder">
              <Status tone={encoder === 'none' ? 'bad' : 'ok'}>{encoder}</Status>
            </Row>
            {/* Desktop Duplication cannot see a fullscreen game and records it as
                a near-black picture. Saying which backend is running turns that
                from a mystery into a one-line answer. */}
            <Row label="Screen capture"
              hint={captureBackend === 'Desktop Duplication' ? 'Fullscreen games may record black on this backend.' : undefined}>
              <Status tone={captureBackend === 'Desktop Duplication' ? 'warn' : 'ok'}>{captureBackend}</Status>
            </Row>
            {health && (
              <Row label="Capture health">
                <Status tone={health.healthy ? 'ok' : 'bad'}>
                  {health.healthy
                    ? `${health.fps.toFixed(0)} fps · ${health.buffered.toFixed(0)}s buffered${health.audioMode ? ` · audio ${health.audioMode}` : ''}`
                    : health.error || 'Capture stopped'}
                </Status>
              </Row>
            )}
          </Section>

          <Section id="Voice" title="Voice" sectionRef={register('Voice')}>
            {!voiceStatus.available ? (
              <p style={{ fontSize: 14, color: 'var(--alert)', paddingTop: 18, lineHeight: 1.6 }}>
                {voiceStatus.error || 'Voice activation is unavailable.'}
              </p>
            ) : (
              <>
                <Row label="Listen for voice commands"
                  hint={<>Say “flash clip that”, “flash clip short” or “flash screenshot”.</>}>
                  <Toggle label="Listen for voice commands" on={settings.voiceEnabled}
                    onChange={() => onChange({ voiceEnabled: !settings.voiceEnabled })} />
                </Row>
                <Row label="Listening device"><Status tone="plain">{window.flash.platform === 'win32' ? 'Windows default input' : 'System default input'}</Status></Row>
                <Row label="Speech language"><Status tone="plain">{voiceStatus.language}</Status></Row>
                <Row label="Custom full-clip phrase"
                  hint={customPhraseTooShort
                    ? <span style={{ color: 'var(--spark)' }}>Use at least three syllables. Short phrases collide with ordinary speech.</span>
                    : 'Optional. Works alongside the built-in phrases.'}>
                  <input
                    type="text"
                    aria-label="Custom full-clip voice phrase"
                    placeholder="e.g. save that play"
                    value={settings.voicePhrase}
                    onChange={event => onChange({ voicePhrase: event.target.value })}
                    className="field"
                    style={{ width: 230 }}
                  />
                </Row>
              </>
            )}
          </Section>

          <Section id="Games" title="Games" sectionRef={register('Games')}>
            <p style={{ fontSize: 13, color: 'var(--muted)', paddingTop: 16, lineHeight: 1.6, maxWidth: 560 }}>
              Names you have taught Flash, used alongside the built-in list to decide which game a clip
              belongs to. Each can override the quality and buffer length.
            </p>
            {Object.keys(learnedGames).length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted-3)', paddingTop: 14 }}>
                Nothing taught yet. Flash recognises {52} games on its own.
              </p>
            ) : (
              <div className="pt-2">
                {Object.entries(learnedGames).map(([exe, name]) => {
                  const override = settings.perGame[name] ?? {}
                  const effective = resolveGameSettings(settings.perGame, name, settings)
                  return (
                    <div key={exe} style={{ padding: '16px 0', borderBottom: '1px solid var(--edge-soft)' }}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate" style={{ fontSize: 14, color: 'var(--fg)' }}>
                          {name} <span style={{ color: 'var(--muted-3)', fontSize: 12 }}>{exe}</span>
                        </span>
                        <button onClick={() => onForgetGame(exe)} title="Forget this name" className="btn btn-sm">
                          Forget
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 pt-3">
                        <Dropdown
                          value={override.quality ?? ''}
                          onChange={quality => updateGameOverride(name, 'quality', quality || undefined)}
                          width={200}
                          options={[
                            { value: '', label: `${effective.quality}`, hint: 'default' },
                            ...QUALITY_OPTIONS.map(quality => ({ value: quality, label: quality, hint: 'set' })),
                          ]}
                        />
                        <Dropdown
                          value={override.bufferLength ?? 0}
                          onChange={bufferLength => updateGameOverride(name, 'bufferLength', bufferLength || undefined)}
                          width={140}
                          options={[
                            { value: 0, label: `${effective.bufferLength}s`, hint: 'default' },
                            ...Array.from({ length: 59 }, (_, index) => 10 + index * 5)
                              .map(bufferLength => ({ value: bufferLength, label: `${bufferLength}s`, hint: 'set' })),
                          ]}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Section>

          <Section id="Overlay" title="Overlay" sectionRef={register('Overlay')}>
            <Row label="Clip saved notification">
              <Toggle label="Clip saved notification" on={settings.notifications} onChange={() => onChange({ notifications: !settings.notifications })} />
            </Row>
            <Row label="In-game overlay"
              hint="Shows recording status over borderless and windowed games. It never hooks the game, so it is safe with anti-cheat, but it cannot draw over exclusive fullscreen.">
              <Toggle label="In-game overlay" on={settings.overlay} onChange={() => onChange({ overlay: !settings.overlay })} />
            </Row>
            {settings.overlay && (
              <Row label="Overlay corner">
                <Dropdown
                  value={settings.overlayPosition}
                  onChange={overlayPosition => onChange({ overlayPosition: overlayPosition as Settings['overlayPosition'] })}
                  width={150}
                  options={[
                    { value: 'top-left', label: 'Top left' },
                    { value: 'top-right', label: 'Top right' },
                    { value: 'bottom-left', label: 'Bottom left' },
                    { value: 'bottom-right', label: 'Bottom right' },
                  ]}
                />
              </Row>
            )}
          </Section>

          <Section id="Storage" title="Storage" sectionRef={register('Storage')}>
            <div className="flex items-end gap-4" style={{ padding: '20px 0 8px' }}>
              <span className="display" style={{ fontSize: 48, color: 'var(--fg)' }}>{formatBytes(storage.used)}</span>
              <span style={{ fontSize: 13, color: 'var(--muted)', paddingBottom: 6 }}>
                across {storage.clips} clip{storage.clips === 1 ? '' : 's'} · MP4 / H.264
              </span>
            </div>
            <Row label="Clips folder" hint={<span className="truncate block" style={{ maxWidth: 420 }} title={settings.clipsFolder}>{settings.clipsFolder}</span>}>
              <button onClick={onOpenFolder} className="btn btn-sm">Open</button>
              <button onClick={onPickFolder} className="btn btn-sm">Change</button>
            </Row>
            <Row label="Auto-delete clips after" hint={settings.autoDeleteDays > 0 ? 'Starred clips are always kept.' : undefined}>
              <Dropdown
                value={settings.autoDeleteDays}
                onChange={autoDeleteDays => onChange({ autoDeleteDays })}
                width={130}
                options={[
                  { value: 0, label: 'Never' },
                  { value: 7, label: '7 days' },
                  { value: 30, label: '30 days' },
                  { value: 90, label: '90 days' },
                ]}
              />
            </Row>
          </Section>
        </div>
      </div>
    </div>
  )
}
