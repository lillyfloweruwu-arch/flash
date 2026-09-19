// The built capture addon, found relative to this file so the probes work from
// any working directory. Build it with:
//   cd packages/flash-capture && ./node_modules/.bin/cmake-js build
const { join } = require('path')
const { existsSync } = require('fs')

const addonPath = join(__dirname, '../../packages/flash-capture/build/Release/flash_capture.node')
if (!existsSync(addonPath)) {
  console.error(`capture addon not built at ${addonPath}`)
  console.error('build it with: cd packages/flash-capture && ./node_modules/.bin/cmake-js build')
  process.exit(1)
}
module.exports = require(addonPath)
