// Exercise actual process/environment teardown, including a forced exit with
// registered TSFNs and worker termination without a JavaScript exit event.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const addonPath = path.join(__dirname, '../../packages/flash-capture/build',
  process.platform === 'win32' ? 'Release' : '', 'flash_capture.node')
if (!existsSync(addonPath)) {
  console.log('SKIP: native teardown checks require a built addon')
  process.exit(0)
}

const setup = `
  const assert = require('node:assert/strict');
  const addon = require(${JSON.stringify(addonPath)});
  for (let i = 0; i < 8; i++) {
    addon.onVoiceCommand(() => {});
    addon.setPortalRestoreToken('', () => {});
  }
`

;(async () => {
  for (const forced of [false, true]) {
    const result = spawnSync(process.execPath, ['-e', `${setup}
      process.on('exit', () => {
        // An exit code alone previously passed on some Windows installations
        // even though all native resources still awaited static destruction.
        // A later listener must see the addon already shut down, and attempts
        // to restart it must fail rather than leave newly started threads alive.
        assert.throws(() => addon.setVoiceEnabled(true), /shutting down/);
        assert.throws(() => addon.initialize(), /shutting down/);
      });
      ${forced ? 'process.exit(0);' : ''}
    `], { stdio: 'inherit', timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.status, 0, result.stderr)
  }

  // Keep a parent environment alive while child environments are destroyed.
  const addon = require(addonPath)
  addon.onVoiceCommand(() => {})
  for (let i = 0; i < 3; i++) {
    const worker = new Worker(`${setup}
      require('node:worker_threads').parentPort.postMessage('ready');
      setInterval(() => {}, 1000);
    `, { eval: true })
    await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    assert.equal(await worker.terminate(), 1)
    assert.doesNotThrow(() => addon.setVoiceEnabled(false))
    addon.onVoiceCommand(() => {})
  }
  console.log('PASS: native shutdown precedes process exit; natural exit, forced exit, callback replacement and worker termination are clean')
})().catch(error => { console.error(error); process.exitCode = 1 })
