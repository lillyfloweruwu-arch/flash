// Palettes ported from FlashDomain so the two apps feel like siblings.
// Imported by both the main process (toast popup) and the renderer, so it lives
// outside src/main and src/renderer.

export interface Theme {
  label: string
  bg: string
  panel: string
  field: string
  edge: string
  hover: string
  fg: string
  muted: string
  accent: string
  accentDim: string
  onAccent: string
  spark: string
  alert: string
}

export const THEMES: Record<string, Theme> = {
  blood: {
    label: 'Blood',
    bg: '#0C0607', panel: '#1C0E11', field: '#28141A', edge: '#4A2029', hover: '#331A21',
    fg: '#FFF0F1', muted: '#BC9599', accent: '#C1121F', accentDim: '#780116',
    onAccent: '#FFF0F1', spark: '#FF9E00',
    // The chrome is red on this theme, so errors move to a hot rose that cannot
    // be mistaken for the interface itself.
    alert: '#FF5C8A',
  },
  ultraviolet: {
    label: 'Electric ultraviolet',
    bg: '#09060F', panel: '#15101F', field: '#20182D', edge: '#38294A', hover: '#292037',
    fg: '#F5F1FA', muted: '#A69BB8', accent: '#B45CFF', accentDim: '#7628C9',
    onAccent: '#15051F', spark: '#FF4FA3', alert: '#FF6B6B',
  },
  cobalt: {
    label: 'Cobalt',
    bg: '#070910', panel: '#101521', field: '#171E2D', edge: '#2B3850', hover: '#202A3B',
    fg: '#F0F4FF', muted: '#94A2BA', accent: '#4D7CFE', accentDim: '#294DBA',
    onAccent: '#050B1E', spark: '#C45CFF', alert: '#FF6B6B',
  },
  fuchsia: {
    label: 'Fuchsia',
    bg: '#0D0710', panel: '#1B111C', field: '#271829', edge: '#452940', hover: '#332032',
    fg: '#FFF1FA', muted: '#BC9BB0', accent: '#FF4FA3', accentDim: '#B01765',
    onAccent: '#1E0512', spark: '#B45CFF',
    // Coral is nearly indistinguishable from this accent, so errors go deeper red.
    alert: '#E01E37',
  },
  indigo: {
    label: 'Deep indigo',
    bg: '#080814', panel: '#121223', field: '#1B1B31', edge: '#2F2F52', hover: '#23233F',
    fg: '#F1F1FF', muted: '#9B9BC0', accent: '#7C74FF', accentDim: '#463CC4',
    onAccent: '#070616', spark: '#FF4FA3', alert: '#FF6B6B',
  },
  bone: {
    label: 'Bone',
    // No hue at all — the only saturated pixels on screen belong to your clips.
    bg: '#0A0A0C', panel: '#151517', field: '#1F1F23', edge: '#33333A', hover: '#26262B',
    fg: '#F2F2F5', muted: '#9C9CA6', accent: '#EDE9F5', accentDim: '#6E6E7A',
    onAccent: '#0A0A0C', spark: '#C9C9D4', alert: '#FF6B6B',
  },
}

export const DEFAULT_THEME = 'blood'

export const getTheme = (name: string): Theme => THEMES[name] ?? THEMES[DEFAULT_THEME]
