// Self-check for clip selection maths. Run with:
//   node --experimental-strip-types src/shared/selection.test.ts
import { strict as assert } from 'node:assert'
import { clearSelection, selectRange, toggleSelection } from './selection.ts'

const toggledOn = toggleSelection(new Set(), 'b')
assert.deepEqual([...toggledOn], ['b'])
assert.deepEqual([...toggleSelection(toggledOn, 'b')], [])

const displayed = ['a', 'b', 'c', 'd', 'e']

// The anchor is below the target in the displayed list.
assert.deepEqual([...selectRange(new Set(), displayed, 'd', 'b')], ['b', 'c', 'd'])

// The anchor is above the target in the displayed list.
assert.deepEqual([...selectRange(new Set(), displayed, 'b', 'd')], ['b', 'c', 'd'])

// Range selection follows what the grid showed, not the source array order.
const resorted = ['c', 'a', 'e', 'b', 'd']
assert.deepEqual([...selectRange(new Set(), resorted, 'a', 'b')], ['a', 'e', 'b'])

assert.deepEqual([...clearSelection()], [])

console.log('clip selection self-check passed')
