// Optional verification shim for Windows sandboxes that deny Node's named
// pipes. Real child processes still run; their output goes through temp files.
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-spawn-'))
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr')
  const descriptors = [fs.openSync(out, 'w+'), fs.openSync(err, 'w+')]
  return { stdio: ['ignore', ...descriptors], finish() {
    descriptors.forEach(fd => fs.closeSync(fd))
    const stdout = fs.readFileSync(out), stderr = fs.readFileSync(err)
    fs.unlinkSync(out); fs.unlinkSync(err); fs.rmdirSync(dir)
    return { stdout, stderr }
  } }
}
cp.execFileSync = (file, args = [], options = {}) => {
  const io = files()
  const child = cp.spawnSync(file, args, { ...options, stdio: io.stdio })
  const output = io.finish()
  if (options.stdio === 'inherit') { process.stdout.write(output.stdout); process.stderr.write(output.stderr) }
  if (child.error || child.status !== 0) throw Object.assign(child.error || new Error(`${file} exited ${child.status}`), output, { status: child.status })
  return options.encoding ? output.stdout.toString(options.encoding) : output.stdout
}
cp.execFile = (file, args, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {} }
  const io = files()
  const child = cp.spawn(file, args || [], { ...options, stdio: io.stdio })
  child.stdin = { destroy() {}, end(value) { if (value) throw new Error('Sandbox shim does not support stdin input') } }
  let spawnError
  child.on('error', error => { spawnError = error })
  child.on('close', code => {
    const output = io.finish()
    callback(spawnError || (code ? Object.assign(new Error(`${file} exited ${code}`), { code }) : null), output.stdout.toString(), output.stderr.toString())
  })
  return child
}
require('node:module').syncBuiltinESMExports()
