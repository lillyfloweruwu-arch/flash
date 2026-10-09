import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { autostartDesktopEntry, linuxConfigHome, steamAppId, linuxGameExecutable } from '../shared/platform'

const autostartPath = () => `${linuxConfigHome(homedir(), process.env.XDG_CONFIG_HOME)}/autostart/flash.desktop`
export function linuxAutostartEnabled(): boolean {
  try { return !/^(Hidden=true|X-GNOME-Autostart-enabled=false)\r?$/m.test(readFileSync(autostartPath(), 'utf8')) }
  catch { return false }
}
export function setLinuxAutostart(enabled: boolean, executable: string): void {
  const path = autostartPath()
  if (!enabled) { if (existsSync(path)) unlinkSync(path); return }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, autostartDesktopEntry(executable), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

// Processes may exit or deny access between any two reads. Preserve whatever
// was readable instead of losing the snapshot to one /proc entry.
export function linuxProcessSnapshot() {
  const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
  const processes = []
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    const dir = `/proc/${pid}`
    const rawCommand = read(`${dir}/cmdline`)
    const cmdline = rawCommand.replace(/\0/g, ' ').trim()
    let path = ''
    try { path = readlinkSync(`${dir}/exe`) } catch { /* Other users may deny exe access. */ }
    const exe = linuxGameExecutable(basename(path) || read(`${dir}/comm`).trim(), rawCommand)
    if (!exe) continue
    const stat = read(`${dir}/stat`), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    processes.push({ pid: Number(pid), exe, path, cmdline, parentPid: Number(fields[1]) || 0,
      steamAppId: steamAppId(read(`${dir}/environ`), cmdline), windowTitle: '',
      workingSet: Number(/VmRSS:\s+(\d+)/.exec(read(`${dir}/status`))?.[1] ?? 0) * 1024,
      startTicks: Number(fields[19]) || 0 })
  }
  return { processes, foregroundPid: 0 }
}
