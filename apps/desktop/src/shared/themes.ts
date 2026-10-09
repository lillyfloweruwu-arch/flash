// Theme palettes for the full-bleed feed look: near-black neutrals with a
// faint tint, and an accent that only ever marks something live or engaged.
// Imported by both the main process (toast popup) and the renderer, so it lives
// outside src/main and src/renderer. Keep in sync with renderer/index.css.

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
    bg: '#0A0A0B', panel: '#121316', field: '#1B1D22', edge: '#2A2D34', hover: '#1F2126',
    fg: '#F2F3F5', muted: '#9AA0AB', accent: '#E8192C', accentDim: '#8C0F1B',
    onAccent: '#FFFFFF', spark: '#FFB020',
    // The accent is red on this theme, so errors move to a hot rose that cannot
    // be mistaken for a live state.
    alert: '#FF6B8E',
  },
  ultraviolet: {
    label: 'Electric ultraviolet',
    bg: '#0A090D', panel: '#131218', field: '#1D1B24', edge: '#2D2A37', hover: '#201E28',
    fg: '#F4F2F8', muted: '#A19CAF', accent: '#B45CFF', accentDim: '#6B2BB3',
    onAccent: '#12051F', spark: '#FF9AD0', alert: '#FF6B6B',
  },
  cobalt: {
    label: 'Cobalt',
    bg: '#090A0D', panel: '#111318', field: '#1A1E25', edge: '#293039', hover: '#1E2229',
    fg: '#F1F4F8', muted: '#98A2B3', accent: '#4D7CFE', accentDim: '#2647A8',
    onAccent: '#050B1E', spark: '#FFB020', alert: '#FF6B6B',
  },
  fuchsia: {
    label: 'Fuchsia',
    bg: '#0C090B', panel: '#151115', field: '#201A1F', edge: '#33292F', hover: '#221B21',
    fg: '#FBF2F7', muted: '#AB9CA6', accent: '#FF4FA3', accentDim: '#A51A62',
    onAccent: '#1E0512', spark: '#FFB020',
    // Coral sits too close to this accent, so errors go deeper red.
    alert: '#FF4D5E',
  },
  indigo: {
    label: 'Deep indigo',
    bg: '#09090D', panel: '#121219', field: '#1B1B25', edge: '#2B2B39', hover: '#1F1F2B',
    fg: '#F2F2FB', muted: '#9D9DB8', accent: '#7C74FF', accentDim: '#4239B8',
    onAccent: '#070616', spark: '#FF9AD0', alert: '#FF6B6B',
  },
  bone: {
    label: 'Bone',
    // No hue at all; the only saturated pixels on screen belong to your clips.
    bg: '#0A0A0A', panel: '#131313', field: '#1C1C1C', edge: '#2C2C2C', hover: '#202020',
    fg: '#F2F2F2', muted: '#A0A0A0', accent: '#F0F0F0', accentDim: '#6A6A6A',
    onAccent: '#0A0A0A', spark: '#D6D6D6', alert: '#FF6B6B',
  },
}

export const DEFAULT_THEME = 'blood'

export const getTheme = (name: string): Theme => THEMES[name] ?? THEMES[DEFAULT_THEME]
