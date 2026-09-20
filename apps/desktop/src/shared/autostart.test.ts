// Self-check for the startup decision. Run with:
//   node --experimental-strip-types src/shared/autostart.test.ts
import { strict as assert } from 'node:assert'
import { decideAutostart } from './autostart.ts'

// developer run (packaged=false) with everything else true
assert.deepEqual(decideAutostart({
  installerRequested: true,
  markerConsumed: false,
  currentlyEnabled: true,
  packaged: false,
}), { apply: false, consumeMarker: false })

// no installer request
assert.deepEqual(decideAutostart({
  installerRequested: false,
  markerConsumed: false,
  currentlyEnabled: false,
  packaged: true,
}), { apply: false, consumeMarker: false })

// already-consumed marker
assert.deepEqual(decideAutostart({
  installerRequested: true,
  markerConsumed: true,
  currentlyEnabled: false,
  packaged: true,
}), { apply: false, consumeMarker: false })

// unconsumed request, already enabled
assert.deepEqual(decideAutostart({
  installerRequested: true,
  markerConsumed: false,
  currentlyEnabled: true,
  packaged: true,
}), { apply: false, consumeMarker: true })

// unconsumed request, not enabled
assert.deepEqual(decideAutostart({
  installerRequested: true,
  markerConsumed: false,
  currentlyEnabled: false,
  packaged: true,
}), { apply: true, consumeMarker: true })

// all 16 combinations
const cases = [
  { installerRequested: false, markerConsumed: false, currentlyEnabled: false, packaged: false },
  { installerRequested: false, markerConsumed: false, currentlyEnabled: false, packaged: true },
  { installerRequested: false, markerConsumed: false, currentlyEnabled: true, packaged: false },
  { installerRequested: false, markerConsumed: false, currentlyEnabled: true, packaged: true },
  { installerRequested: false, markerConsumed: true, currentlyEnabled: false, packaged: false },
  { installerRequested: false, markerConsumed: true, currentlyEnabled: false, packaged: true },
  { installerRequested: false, markerConsumed: true, currentlyEnabled: true, packaged: false },
  { installerRequested: false, markerConsumed: true, currentlyEnabled: true, packaged: true },
  { installerRequested: true, markerConsumed: false, currentlyEnabled: false, packaged: false },
  { installerRequested: true, markerConsumed: false, currentlyEnabled: false, packaged: true },
  { installerRequested: true, markerConsumed: false, currentlyEnabled: true, packaged: false },
  { installerRequested: true, markerConsumed: false, currentlyEnabled: true, packaged: true },
  { installerRequested: true, markerConsumed: true, currentlyEnabled: false, packaged: false },
  { installerRequested: true, markerConsumed: true, currentlyEnabled: false, packaged: true },
  { installerRequested: true, markerConsumed: true, currentlyEnabled: true, packaged: false },
  { installerRequested: true, markerConsumed: true, currentlyEnabled: true, packaged: true },
]

let applyTrueCount = 0
let applyTrueCase = ''
for (const c of cases) {
  const result = decideAutostart(c)
  if (result.apply) {
    applyTrueCount++
    applyTrueCase = JSON.stringify(c)
  }
}
assert.equal(applyTrueCount, 1, `expected exactly one case with apply=true, got ${applyTrueCount}`)
assert.ok(applyTrueCase.length > 0, 'expected to identify the case')

console.log('autostart decision self-check passed')
