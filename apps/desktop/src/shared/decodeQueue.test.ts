import { strict as assert } from 'node:assert'
import { createDecodeQueue } from './decodeQueue.ts'

const calls: string[] = []
const completions: (() => void)[] = []
let active = 0, peak = 0
const request = createDecodeQueue(async path => {
  calls.push(path)
  peak = Math.max(peak, ++active)
  await new Promise<void>(resolve => completions.push(resolve))
  active--
  return path
})
const first = request('first')
const duplicate = request('first')
assert.equal(first.promise, duplicate.promise)
await Promise.resolve()
let last = request('0')
for (let i = 1; i <= 100; i++) {
  const previous = last
  previous.release()
  last = request(String(i))
  assert.equal(await previous.promise, undefined)
}
assert.deepEqual(calls, ['first'])
completions.shift()!()
assert.equal(await first.promise, 'first')
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(calls, ['first', '100'])
completions.shift()!()
assert.equal(await last.promise, '100')
assert.equal(peak, 1)
assert.equal(active, 0)
first.release(); duplicate.release(); last.release()
console.log('PASS: 102 requests, 2 decodes, peak active 1, pending bounded to 1, active after completion 0')
