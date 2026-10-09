// electron-builder afterPack hook: drop Chromium pieces Flash never loads.
//
// dxcompiler.dll and dxil.dll are the DirectX Shader Compiler, used only by
// WebGPU (Dawn on D3D12). Flash draws with plain DOM/CSS and decodes video
// through D3D11, so the pair is ~26 MB of dead weight in a lightweight
// clipper. ANGLE still has d3dcompiler_47.dll, which is kept.
const { rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  for (const name of ['dxcompiler.dll', 'dxil.dll']) {
    const file = join(context.appOutDir, name)
    if (existsSync(file)) rmSync(file)
  }
}
