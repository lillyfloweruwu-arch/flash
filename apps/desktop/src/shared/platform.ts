// Kept free of Electron so platform decisions can be checked on Windows.
export function clipPathFromUrl(value: string, platform: string): string {
  const url = new URL(value)
  if (url.protocol !== 'flash-clip:' || url.hostname !== 'local' || url.username || url.password || url.port) throw new Error('Invalid clip URL')
  const path = decodeURIComponent(url.pathname)
  if (path.includes('\0')) throw new Error('Invalid clip path')
  if (platform === 'win32') {
    const windows = path.slice(1).replace(/\//g, '\\')
    if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/i.test(windows)) throw new Error('Expected an absolute Windows path')
    return windows
  }
  return path
}

export type CaptureCommand = 'clip' | 'short' | 'screenshot'
export function captureCommand(argv: readonly string[]): CaptureCommand | null {
  if (argv.includes('--save-clip')) return 'clip'
  if (argv.includes('--save-short')) return 'short'
  if (argv.includes('--screenshot')) return 'screenshot'
  return null
}

export function linuxConfigHome(home: string, xdg?: string): string {
  return xdg?.startsWith('/') ? xdg.replace(/\/$/, '') : `${home}/.config`
}

export function autostartDesktopEntry(executable: string): string {
  if (!executable.startsWith('/') || /[\r\n\0]/.test(executable)) throw new Error('Invalid executable path')
  // Exec quoting is followed by desktop-file string unescaping.
  const quoted = executable.replace(/[%]/g, '%%').replace(/[\\"`$]/g, '\\$&').replace(/\\/g, '\\\\')
  return `[Desktop Entry]\nType=Application\nName=Flash\nExec="${quoted}" --autostart\nIcon=flash\nTerminal=false\nStartupWMClass=flash\nX-GNOME-Autostart-enabled=true\n`
}

export const isLinuxInfrastructure = (exe: string): boolean =>
  /^(?:wine(?:64)?(?:-preloader)?|wineserver|proton|steam|steamwebhelper|pressure-vessel.*|reaper|srt-bwrap)(?:\.exe)?$/i.test(exe)

export function linuxGameExecutable(exe: string, cmdline: string): string {
  if (!/^wine(?:64)?(?:-preloader)?$/i.test(exe)) return exe
  for (const argument of cmdline.split('\0')) {
    const candidate = argument.split(/[/\\]/).at(-1) ?? ''
    if (/\.exe$/i.test(candidate) && !isLinuxInfrastructure(candidate)) return candidate
  }
  return exe
}

export function steamAppId(environment: string, cmdline: string): string {
  const env = /(?:^|\0)(?:SteamAppId|STEAM_COMPAT_APP_ID)=([1-9]\d*)(?:\0|$)/.exec(environment)
  return env?.[1] ?? /(?:\/|\\)compatdata(?:\/|\\)([1-9]\d*)(?:\/|\\|\s|$)/.exec(cmdline)?.[1] ?? ''
}
