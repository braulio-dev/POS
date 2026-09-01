/**
 * Generates build/icon.png, the source electron-builder converts into the
 * installer and taskbar icon.
 *
 * Written as code rather than committed as a binary so the shop's green stays
 * tied to --green in src/styles.css instead of drifting from it. It is a
 * placeholder: swap in a real logo when there is one and this can go.
 *
 * Run with: node scripts/make-icon.cjs
 */
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 256
const GREEN = [76, 175, 80]      // --green
const GREEN_DARK = [67, 160, 71] // --green-dark
const WHITE = [255, 255, 255]

/** Signed distance to a rounded rectangle, used to antialias its edge. */
function roundedRectSDF(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r)
  const dy = Math.abs(y - cy) - (halfH - r)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - r
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t))
}

/** Coverage from a distance field: 1 inside, 0 outside, soft across one pixel. */
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d))

const px = (x, y) => {
  const c = SIZE / 2

  // Body: a rounded tile in the app's green, with a soft vertical shade so the
  // icon still reads as an object at 16px in the taskbar.
  const body = coverage(roundedRectSDF(x, y, c, c, 118, 118, 30))
  const base = mix(GREEN, GREEN_DARK, y / SIZE)

  // Glyph: a receipt with a torn bottom edge and two text lines. A till slip is
  // the one thing this app produces that a shopkeeper recognises instantly.
  const slip = coverage(roundedRectSDF(x, y, c, c - 6, 46, 62, 6))
  // The tear: sawtooth notches cut off the bottom of the slip.
  const toothW = 15.5
  const phase = Math.abs(((x - c + 46) % toothW) - toothW / 2)
  const tearTop = c + 44 + phase - toothW / 4
  const torn = y > tearTop ? 0 : 1

  const line1 = coverage(roundedRectSDF(x, y, c, c - 30, 28, 5, 2.5))
  const line2 = coverage(roundedRectSDF(x, y, c, c - 8, 28, 5, 2.5))
  const line3 = coverage(roundedRectSDF(x, y, c - 10, c + 14, 18, 5, 2.5))

  const glyph = Math.min(slip * torn, 1)
  const ink = Math.max(line1, line2, line3) * glyph

  let rgb = base
  rgb = mix(rgb, WHITE, glyph)
  rgb = mix(rgb, GREEN_DARK, ink)
  return [...rgb, Math.round(body * 255)]
}

// Raw PNG scanlines: one filter byte (0 = none) then RGBA per pixel.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
let o = 0
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = px(x + 0.5, y + 0.5)
    raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8   // bit depth
ihdr[9] = 6   // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(__dirname, '..', 'build', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`)
