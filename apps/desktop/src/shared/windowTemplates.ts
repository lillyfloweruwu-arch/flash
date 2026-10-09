import { getTheme, WINDOW_TOKENS } from './themes.ts'

function style(theme: string, font: string) {
  const t = getTheme(theme)
  return `
    @font-face{font-family:Antonio;src:url('${font}') format('woff2');font-weight:100 700;font-display:swap}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;background:transparent;color:${t.fg};overflow:hidden}
    .surface{background:${t.bg};border:1px solid ${t.edge};border-radius:${WINDOW_TOKENS.popover}px}
    .label{font-size:11px;font-weight:600;letter-spacing:${WINDOW_TOKENS.tracking};text-transform:uppercase}
    .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${t.accent}}
    .dot.idle{background:${t.muted}}
    .dot.live{animation:pulse 1.6s ease-in-out infinite}
    @keyframes pulse{50%{opacity:.4}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
  `
}

export function toastHtml(theme: string, font: string, durationSeconds: number) {
  const seconds = Math.max(0, Math.floor(durationSeconds))
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${style(theme, font)}
    .toast{height:72px;display:flex;align-items:center;gap:12px;padding:12px 18px;animation:enter .16s ease-out}
    h3{font-family:Antonio,'Bahnschrift SemiCondensed','Arial Narrow',sans-serif;font-size:26px;font-weight:600;line-height:.92;letter-spacing:-.005em;text-transform:uppercase;margin-bottom:7px}
    .label{font-size:10px;font-variant-numeric:tabular-nums}
    @keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  </style></head><body><div class="surface toast"><div><h3>Clip saved</h3><p class="label">${duration} saved to library</p></div></div></body></html>`
}

export function overlayHtml(theme: string, font: string) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${style(theme, font)}
    .pill{height:40px;display:flex;align-items:center;gap:9px;padding:10px 14px;opacity:0;transition:opacity .16s ease}
    .pill.on{opacity:1}
    .label{flex-shrink:0}
    .game{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  </style></head><body><div class="surface pill" id="pill"><div class="dot" id="dot"></div><span class="label" id="label">REC</span><span class="game" id="game"></span></div>
    <script>window.setState = s => {
      document.getElementById('pill').className = 'surface pill' + (s.visible ? ' on' : '')
      document.getElementById('dot').className = 'dot ' + (s.recording || s.saving ? 'live' : 'idle')
      document.getElementById('label').textContent = s.saving ? 'SAVING' : s.recording ? 'REC' : 'IDLE'
      document.getElementById('game').textContent = s.game || ''
    }</script></body></html>`
}

export function cornerBounds(area: { x: number; y: number; width: number; height: number }, position: string, width: number, height: number) {
  const pad = 16
  return { width, height,
    x: position.endsWith('right') ? area.x + area.width - width - pad : area.x + pad,
    y: position.startsWith('bottom') ? area.y + area.height - height - pad : area.y + pad,
  }
}
