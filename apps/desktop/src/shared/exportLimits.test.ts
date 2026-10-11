// Self-check for the share-copy size menu. Run with:
//   node --experimental-strip-types src/shared/exportLimits.test.ts
import { strict as assert } from 'node:assert'
import { EXPORT_LIMITS, DEFAULT_EXPORT_LIMIT, codecNote, exportSuffix, findExportLimit } from './exportLimits.ts'

// Every entry is reachable by its id, and ids are unique.
assert.equal(new Set(EXPORT_LIMITS.map(limit => limit.value)).size, EXPORT_LIMITS.length)
for (const limit of EXPORT_LIMITS) assert.equal(findExportLimit(limit.value), limit)

// An id from an older build, or junk, falls back to the first entry.
assert.equal(findExportLimit('nope'), EXPORT_LIMITS[0])
assert.equal(findExportLimit(String(10 * 1048576)), EXPORT_LIMITS[0])

// Every platform defaults to the best codec the GPU can encode, at 10MB.
assert.equal(findExportLimit(DEFAULT_EXPORT_LIMIT).codec, 'auto')
assert.equal(findExportLimit(DEFAULT_EXPORT_LIMIT).bytes, 10 * 1048576)

// The two 10MB copies of one clip get different names.
assert.equal(exportSuffix(10 * 1048576, 'auto'), ' - 10MB.mp4')
assert.equal(exportSuffix(10 * 1048576, 'h264'), ' - 10MB H264.mp4')
assert.equal(exportSuffix(500 * 1048576, 'auto'), ' - 500MB.mp4')

// The note only speaks up when Auto did not get AV1.
assert.equal(codecNote('auto', 'av1'), '')
assert.equal(codecNote('auto', 'hevc'), 'Exported as HEVC (no AV1 encoder on this GPU)')
assert.equal(codecNote('auto', 'h264'), 'Exported as H.264 (no AV1 encoder on this GPU)')
assert.equal(codecNote('h264', 'h264'), '')
assert.equal(codecNote('auto', undefined), '')

console.log('exportLimits self-check passed')
