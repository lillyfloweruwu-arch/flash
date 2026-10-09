// Runs every self-check in the repo: the TypeScript ones under apps/desktop/src/shared,
// and the native ones under packages/flash-capture/build (Release on Windows).
// Native checks are skipped (not failed) when the addon has not been built — a clone
// without Visual Studio should still be able to run the TypeScript half.
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shared = join(root, 'apps/desktop/src/shared')
const nativeDir = join(root, `packages/flash-capture/build${process.platform === 'win32' ? '/Release' : ''}`)

const run = (label, file, args, cwd) => {
  try {
    execFileSync(file, args, { cwd, stdio: 'inherit' })
    console.log(`  pass  ${label}`)
    return true
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message
    console.log(`  FAIL  ${label}`)
    if (output) console.log(output.split('\n').map(line => `        ${line}`).join('\n'))
    return false
  }
}

let failed = 0

console.log('TypeScript self-checks')
for (const file of readdirSync(shared).filter(name => name.endsWith('.test.ts'))) {
  if (!run(file, process.execPath, ['--experimental-strip-types', join(shared, file)], shared)) failed++
}

console.log('Safe integration probes')
for (const [file, args] of [
  ['sidecars.js', []], ['preload-subscriptions.js', []], ['main-boundaries.js', []], ['deletion-retry.js', []],
  ['export-and-game.js', ['--safe']],
]) {
  if (!run(file, process.execPath, ['--experimental-strip-types', join(root, 'scripts/probes', file), ...args], root)) failed++
}

if (process.env.FLASH_HARDWARE_TESTS === '1') {
  for (const file of ['export-and-game.js', 'reapply-settings.js']) {
    if (!run(file, process.execPath, ['--experimental-strip-types', join(root, 'scripts/probes', file)], root)) failed++
  }
} else {
  console.log('  skip  live capture/export and idle-reset probes (set FLASH_HARDWARE_TESTS=1)')
}

console.log('Native self-checks')
if (!existsSync(nativeDir)) {
  console.log('  skip  capture addon not built (pnpm --filter @flash/capture run build)')
} else {
  // Reuse the configured build tree. CMake.js is needed to configure the addon,
  // but rediscovering Visual Studio on every test run is unnecessary. Inherit
  // output so native failures and integration probe measurements stay visible.
  const capture = join(root, 'packages/flash-capture')
  try {
    execFileSync('cmake', ['--build', 'build', '--config', 'Release', '--target', 'flash_tests'],
      { cwd: capture, stdio: 'inherit' })
  } catch (error) {
    console.log(`  FAIL  building the self-checks: ${error.message}`)
    failed++
  }

  const tests = readdirSync(nativeDir)
    .filter(name => name.startsWith('flash_') && name.endsWith(process.platform === 'win32' ? '_test.exe' : '_test'))
  if (!tests.length) { console.log('  FAIL  no test binaries built'); failed++ }
  for (const exe of tests) {
    if (exe === 'flash_screenshot_test.exe' && process.env.FLASH_HARDWARE_TESTS !== '1') {
      console.log('  skip  flash_screenshot_test.exe (live desktop; set FLASH_HARDWARE_TESTS=1)')
      continue
    }
    if (!run(exe, join(nativeDir, exe), [], nativeDir)) failed++
  }
}

if (failed) {
  console.log(`\n${failed} check${failed === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('\nall checks passed')
