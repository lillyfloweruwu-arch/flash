// Exercises the actual preload bridge against an EventEmitter, without Electron.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { stripTypeScriptTypes } = require('node:module')
const { runInNewContext } = require('node:vm')

let api
const ipcRenderer = new EventEmitter()
const source = stripTypeScriptTypes(readFileSync(join(__dirname, '../../apps/desktop/src/preload/preload.ts'), 'utf8'))
  .replace(/^import .* from 'electron'\r?\n/m, '')
runInNewContext(source, {
  process: { platform: process.platform },
  ipcRenderer,
  contextBridge: { exposeInMainWorld(_name, value) { api = value } },
})
assert.equal(api.platform, process.platform)
const methods = [
  [api, 'onRecordingState', 'recording-state'], [api, 'onHotkeyClip', 'hotkey-clip'],
  [api, 'onClipSavedRefresh', 'clip-saved-refresh'], [api, 'onIdentifyGame', 'identify-game'],
  [api, 'onNavigate', 'navigate'], [api, 'onPlayClipSound', 'play-clip-sound'],
  [api, 'onGameDetected', 'game-detected'], [api.capture, 'onSaveState', 'clip-save-state'],
]
for (const [owner, method, channel] of methods) {
  let calls = 0
  for (let mount = 0; mount < 2; mount++) {
    const unsubscribe = owner[method](() => { calls++ })
    assert.equal(typeof unsubscribe, 'function')
    assert.equal(ipcRenderer.listenerCount(channel), 1)
    ipcRenderer.emit(channel, {}, 'payload')
    unsubscribe()
    unsubscribe()
    assert.equal(ipcRenderer.listenerCount(channel), 0)
    ipcRenderer.emit(channel, {}, 'payload')
  }
  assert.equal(calls, 2)
}
console.log('PASS: all 8 preload subscriptions clean up across repeated mounts')
