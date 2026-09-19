// Runs every self-check in the repo: the TypeScript ones under apps/desktop/src/shared,
// and the native ones already built under packages/flash-capture/build/Release.
// Native checks are skipped (not failed) when the addon has not been built — a clone
// without Visual Studio should still be able to run the TypeScript half.
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shared = join(root, 'apps/desktop/src/shared')
const nativeDir = join(root, 'packages/flash-capture/build/Release')

const run = (label, file, args, cwd) => {
  try {
    execFileSync(file, args, { cwd, stdio: 'pipe' })
    console.log(`  pass  ${label}`)
    return true
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
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

console.log('Native self-checks')
if (!existsSync(nativeDir)) {
  console.log('  skip  capture addon not built (pnpm --filter @flash/capture run build)')
} else {
  // Rebuild first. The binaries are excluded from the default target, so
  // without this a test run grades whatever was compiled last — which is how a
  // suite ends up green against code that no longer exists.
  // Run the CLI's entry script through node rather than the .cmd shim: Node
  // refuses to execFile a .cmd without a shell, and the failure comes back with
  // an empty message.
  const capture = join(root, 'packages/flash-capture')
  try {
    execFileSync(process.execPath,
      [join(capture, 'node_modules/cmake-js/bin/cmake-js'), 'build', '--target', 'flash_tests'],
      { cwd: capture, stdio: 'pipe' })
  } catch (error) {
    console.log('  FAIL  building the self-checks')
    console.log(`${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-12)
      .map(line => `        ${line}`).join('\n'))
    failed++
  }

  const tests = readdirSync(nativeDir)
    .filter(name => name.startsWith('flash_') && name.endsWith('_test.exe'))
  if (!tests.length) console.log('  skip  no test binaries built')
  for (const exe of tests) {
    if (!run(exe, join(nativeDir, exe), [], nativeDir)) failed++
  }
}

if (failed) {
  console.log(`\n${failed} check${failed === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('\nall checks passed')
