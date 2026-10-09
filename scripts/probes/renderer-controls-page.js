const { ipcRenderer } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const ts = require('../../apps/desktop/node_modules/typescript')
require.extensions['.ts'] = require.extensions['.tsx'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, file)
const React = require('../../apps/desktop/node_modules/react')
const { createRoot } = require('../../apps/desktop/node_modules/react-dom/client')
const { flushSync } = require('../../apps/desktop/node_modules/react-dom')
const { ConfirmDialog } = require('../../apps/desktop/src/renderer/ui.tsx')
const { Dropdown } = require('../../apps/desktop/src/renderer/Dropdown.tsx')
const assert = require('node:assert/strict')
const root = createRoot(document.getElementById('root'))
const key = (name, modifiers) => ipcRenderer.invoke('probe-key', name, modifiers)
const tick = () => new Promise(resolve => setTimeout(resolve, 50))
const render = element => flushSync(() => root.render(element))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-dialog-'))

;(async () => {
  let deleted = 0
  const file = path.join(scratch, 'fixture.mp4')
  const opener = document.getElementById('opener')
  const mount = () => {
    fs.writeFileSync(file, 'keep unless confirmed')
    opener.focus()
    render(React.createElement(ConfirmDialog, { request: { title: 'Delete clip?', confirmLabel: 'Delete', destructive: true,
      onConfirm: () => { deleted++; fs.unlinkSync(file) },
    }, onClose: () => render(null) }))
  }
  mount()
  assert.equal(document.activeElement.textContent, 'Cancel')
  await key('Return')
  assert(fs.existsSync(file)); assert.equal(deleted, 0); assert.equal(document.activeElement, opener)
  mount()
  await key('Tab')
  assert.equal(document.activeElement.textContent, 'Delete')
  await key('Tab')
  assert.equal(document.activeElement.textContent, 'Cancel')
  await key('Tab', ['shift'])
  assert.equal(document.activeElement.textContent, 'Delete')
  await key('Return')
  assert(!fs.existsSync(file)); assert.equal(deleted, 1); assert.equal(document.activeElement, opener)
  mount()
  await key('Tab'); await key('Space')
  assert.equal(deleted, 2); assert(!fs.existsSync(file))
  mount()
  await key('Escape')
  assert(fs.existsSync(file)); assert.equal(deleted, 2); assert.equal(document.activeElement, opener)
  mount()
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Delete')
  button.click(); button.click()
  assert.equal(deleted, 3)
  render(null)

  let navigation = 0, selection = 10
  const watch = event => { if (event.key.startsWith('Arrow')) navigation++ }
  window.addEventListener('keydown', watch)
  function Control() {
    const [value, setValue] = React.useState(10)
    return React.createElement('div', { style: { position: 'fixed', bottom: 20, left: 20 } },
      React.createElement(Dropdown, { value, options: Array.from({ length: 60 }, (_, i) => ({ value: (i + 1) * 5, label: `${(i + 1) * 5} seconds` })),
        onChange: value => { selection = value; setValue(value) } }))
  }
  for (const zoom of [1, 1.5]) {
    // Chromium zoom changes the available CSS viewport just like display scaling.
    require('electron').webFrame.setZoomFactor(zoom)
    render(React.createElement(Control))
    document.querySelector('[aria-haspopup]').focus()
    await key('ArrowDown'); await tick(); await key('End'); await tick()
    const menu = document.querySelector('[role=listbox]')
    const last = menu.lastElementChild
    const bounds = menu.getBoundingClientRect(), row = last.getBoundingClientRect()
    assert(bounds.top >= 0 && bounds.bottom <= innerHeight)
    assert(row.top >= bounds.top && row.bottom <= bounds.bottom + 1)
    await key('Return'); assert.equal(selection, 300)
    await key('ArrowUp'); await tick(); await key('ArrowUp'); await key('Return')
    assert.equal(selection, 295); assert.equal(navigation, 0)
    render(null)
  }
  window.removeEventListener('keydown', watch)
  ipcRenderer.send('probe-result', null)
})().catch(error => ipcRenderer.send('probe-result', error.stack)).finally(() => {
  root.unmount()
  fs.rmSync(scratch, { recursive: true, force: true })
})
