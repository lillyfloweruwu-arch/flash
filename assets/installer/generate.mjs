// Generates the NSIS installer artwork.
//
// NSIS wants 24-bit BMP; PNG is silently ignored, and 32-bit BMP renders with a
// black box on some Windows versions. Generating rather than hand-drawing means
// the artwork can be regenerated when the brand moves.
//
//   node assets/installer/generate.mjs

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Straight from the app's own theme in src/renderer/index.css, so the installer
// and the thing it installs are the same colour.
const BG = [0x07, 0x06, 0x0c]        // --bg   #0c0607, stored BGR
const ACCENT = [0x1f, 0x12, 0xc1]    // --accent #c1121f
const FG = [0xf1, 0xf0, 0xff]        // --fg   #fff0f1
const MUTED = [0x99, 0x95, 0xbc]     // --muted #bc9599

function canvas(width, height, fill) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = fill[0]
    pixels[i * 3 + 1] = fill[1]
    pixels[i * 3 + 2] = fill[2]
  }
  return { width, height, pixels }
}

function put(image, x, y, colour) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return
  const at = (py * image.width + px) * 3
  image.pixels[at] = colour[0]
  image.pixels[at + 1] = colour[1]
  image.pixels[at + 2] = colour[2]
}

// Thickness is drawn as a small filled square per sample: crude, but at this
// size anything cleverer is invisible.
function dot(image, x, y, colour, weight) {
  const r = (weight - 1) / 2
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) put(image, x + dx, y + dy, colour)
  }
}

function line(image, x1, y1, x2, y2, colour, weight = 2) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 3 + 1
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    dot(image, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, colour, weight)
  }
}

function circle(image, cx, cy, radius, colour, weight = 2) {
  const steps = Math.max(24, Math.round(radius * 12))
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    dot(image, cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, colour, weight)
  }
}

// The same running stickman as StickmanIcon in App.tsx, on its 24x24 grid so
// the proportions match the app rather than being redrawn by eye.
function stickman(image, originX, originY, scale, colour, weight) {
  const X = x => originX + x * scale
  const Y = y => originY + y * scale
  circle(image, X(14), Y(3.5), 2 * scale, colour, weight)
  const strokes = [
    [14, 5.5, 12, 11], [12, 8, 8.5, 6.5], [12, 8, 16, 6],
    [12, 11, 9, 16], [9, 16, 7, 14], [12, 11, 15, 15.5], [15, 15.5, 18, 17],
  ]
  for (const [x1, y1, x2, y2] of strokes) line(image, X(x1), Y(y1), X(x2), Y(y2), colour, weight)
}

// A 5x7 block alphabet. Only the letters "FLASH" are needed, and pulling in a
// font renderer for five glyphs would be absurd.
const GLYPHS = {
  F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
}

function word(image, text, x, y, pixel, colour) {
  let cursor = x
  for (const character of text) {
    const glyph = GLYPHS[character]
    if (!glyph) { cursor += pixel * 3; continue }
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row].length; column++) {
        if (glyph[row][column] !== '1') continue
        for (let dy = 0; dy < pixel; dy++) {
          for (let dx = 0; dx < pixel; dx++) {
            put(image, cursor + column * pixel + dx, y + row * pixel + dy, colour)
          }
        }
      }
    }
    cursor += pixel * 6
  }
}

// BMP rows are bottom-up and padded to a multiple of four bytes.
function writeBmp(path, image) {
  const rowSize = image.width * 3
  const padding = (4 - (rowSize % 4)) % 4
  const dataSize = (rowSize + padding) * image.height
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'ascii')
  header.writeUInt32LE(54 + dataSize, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(image.width, 18)
  header.writeInt32LE(image.height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(dataSize, 34)

  const body = Buffer.alloc(dataSize)
  let at = 0
  for (let y = image.height - 1; y >= 0; y--) {
    image.pixels.copy(body, at, y * rowSize, y * rowSize + rowSize)
    at += rowSize + padding
  }
  writeFileSync(path, Buffer.concat([header, body]))
  console.log(`  ${path.split(/[\\/]/).pop().padEnd(24)} ${image.width}x${image.height}  24-bit`)
}

// Header: 150x57, shown on every interior wizard page.
const header = canvas(150, 57, BG)
stickman(header, 96, 8, 1.7, ACCENT, 2)
word(header, 'FLASH', 12, 24, 2, FG)
writeBmp(join(here, 'header.bmp'), header)

// Sidebar: 164x314, welcome and finish pages.
function sidebar(accent) {
  const image = canvas(164, 314, BG)
  stickman(image, 52, 60, 2.6, accent, 3)
  word(image, 'FLASH', 34, 150, 3, FG)
  for (let x = 34; x < 130; x++) put(image, x, 176, MUTED)
  return image
}
writeBmp(join(here, 'sidebar.bmp'), sidebar(ACCENT))
writeBmp(join(here, 'sidebar-uninstall.bmp'), sidebar(MUTED))
