// Compares the native process list against tasklist, which is what it replaces.
const addon = require('./addon')
const { execFile } = require('child_process')

const tasklist = () => new Promise(resolve => {
  execFile('tasklist', ['/FO', 'CSV', '/NH'], (error, stdout) => {
    const names = new Map()
    for (const line of (stdout || '').split('\n')) {
      const fields = line.match(/^"([^"]*)","([^"]*)"/)
      if (fields) names.set(Number(fields[2]), fields[1].toLowerCase())
    }
    resolve(names)
  })
})

;(async () => {
  const t0 = Date.now()
  const snap = addon.listProcesses()
  const nativeMs = Date.now() - t0
  const t1 = Date.now()
  const listed = await tasklist()
  const tasklistMs = Date.now() - t1

  const native = new Map(snap.processes.map(p => [p.pid, p.exe.toLowerCase()]))
  let agree = 0, disagree = 0, missing = 0
  for (const [pid, exe] of listed) {
    const found = native.get(pid)
    if (!found) missing++
    else if (found === exe) agree++
    else { disagree++; if (disagree < 4) console.log(`  differ pid ${pid}: native="${found}" tasklist="${exe}"`) }
  }
  console.log(`native ${native.size} processes in ${nativeMs}ms; tasklist ${listed.size} in ${tasklistMs}ms`)
  console.log(`same name: ${agree}   different: ${disagree}   not seen by native: ${missing}`)
  const titled = snap.processes.filter(p => p.windowTitle)
  console.log(`window titles: ${titled.length}, foreground pid ${snap.foregroundPid} = ` +
    (native.get(snap.foregroundPid) ?? 'unknown'))
  console.log(`biggest titled: ` + titled.sort((a, b) => b.workingSet - a.workingSet).slice(0, 3)
    .map(p => `${p.exe} ${(p.workingSet / 1e6).toFixed(0)}MB`).join(', '))
  process.exit(disagree === 0 && missing <= 2 ? 0 : 1)
})()
