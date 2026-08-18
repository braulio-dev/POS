/**
 * Builds ESC/POS byte streams for the POS58 (58mm thermal, 203 dpi).
 *
 * At 203 dpi the printable width is 384 dots. Font A is 12 dots wide, so a line
 * is exactly 32 characters — every layout decision below follows from that one
 * number.
 */

const WIDTH = 32

// --- Commands -------------------------------------------------------------

const ESC = 0x1b
const GS = 0x1d

const CMD = {
  init: Buffer.from([ESC, 0x40]),
  // ESC t 2 -> code page PC850 (Multilingual Latin 1), which has the Spanish
  // accented characters. Without this the printer defaults to PC437 and "PIÑA"
  // comes out as "PI±A".
  codepagePC850: Buffer.from([ESC, 0x74, 0x02]),
  alignLeft: Buffer.from([ESC, 0x61, 0x00]),
  alignCenter: Buffer.from([ESC, 0x61, 0x01]),
  boldOn: Buffer.from([ESC, 0x45, 0x01]),
  boldOff: Buffer.from([ESC, 0x45, 0x00]),
  sizeNormal: Buffer.from([GS, 0x21, 0x00]),
  sizeDoubleHeight: Buffer.from([GS, 0x21, 0x01]),
  sizeDoubleBoth: Buffer.from([GS, 0x21, 0x11]),
  feed: (n) => Buffer.from([ESC, 0x64, n]),
  // Partial cut. Printers without a cutter ignore it, so it is safe to send
  // even though this POS58 may only have a tear bar.
  cut: Buffer.from([GS, 0x56, 0x42, 0x00]),
}

// --- Text encoding --------------------------------------------------------

// Only the characters a Spanish-language receipt actually needs. Anything else
// non-ASCII degrades to '?' rather than printing garbage.
const PC850 = {
  'á': 0xa0, 'é': 0x82, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3,
  'Á': 0xb5, 'É': 0x90, 'Í': 0xd6, 'Ó': 0xe0, 'Ú': 0xe9,
  'ñ': 0xa4, 'Ñ': 0xa5, 'ü': 0x81, 'Ü': 0x9a,
  '¿': 0xa8, '¡': 0xad, '°': 0xf8, 'º': 0xa7, 'ª': 0xa6,
}

function encode(text) {
  const out = Buffer.alloc(text.length)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const code = ch.charCodeAt(0)
    out[i] = code < 0x80 ? code : (PC850[ch] ?? 0x3f)
  }
  return out
}

const text = (s) => encode(s)
const line = (s = '') => encode(`${s}\n`)

// --- Layout helpers -------------------------------------------------------

/** Left text, right text, dot-free gap between. Right side always survives. */
function columns(left, right, width = WIDTH) {
  const r = String(right)
  const room = width - r.length - 1
  const l = left.length > room ? `${left.slice(0, room - 1)}…` : left
  return `${l}${' '.repeat(Math.max(1, width - l.length - r.length))}${r}`
}

const rule = (char = '-') => char.repeat(WIDTH)

const money = (cents) => {
  const abs = Math.abs(Math.round(cents))
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function timestamp(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// --- Receipts -------------------------------------------------------------

/**
 * @param {object} sale
 * @param {{name:string, unitPriceCents:number, qty:number}[]} sale.items
 * @param {string} storeName
 */
function buildReceipt(sale, storeName = 'Abarrotes "El Paisa"') {
  const parts = [
    CMD.init,
    CMD.codepagePC850,
    CMD.alignCenter,
    CMD.boldOn,
    CMD.sizeDoubleBoth,
    // Double-width halves the usable columns, so the title gets 16 characters.
    line(storeName.length > 16 ? 'EL PAISA' : storeName),
    CMD.sizeNormal,
    CMD.boldOff,
    line(timestamp(sale.createdAt)),
    CMD.alignLeft,
    line(rule()),
  ]

  for (const item of sale.items) {
    const label = item.qty > 1 ? `${item.qty} x ${item.name}` : item.name
    parts.push(line(columns(label, money(item.unitPriceCents * item.qty))))
    if (item.qty > 1) {
      parts.push(line(`   @ ${money(item.unitPriceCents)} c/u`))
    }
  }

  parts.push(
    line(rule()),
    CMD.boldOn,
    CMD.sizeDoubleHeight,
    line(columns('TOTAL', money(sale.totalCents), WIDTH)),
    CMD.sizeNormal,
    CMD.boldOff,
    line(columns('RECIBIDO', money(sale.receivedCents))),
    line(columns('CAMBIO', money(sale.changeCents))),
    line(rule()),
    CMD.alignCenter,
    line('Gracias por su compra'),
    line(`Folio ${String(sale.folio ?? '').slice(0, 8)}`),
    CMD.feed(3),
    CMD.cut,
  )

  return Buffer.concat(parts)
}

/** Exercises alignment, bold, both text sizes, the code page and the cutter. */
function buildTestPage() {
  return Buffer.concat([
    CMD.init,
    CMD.codepagePC850,
    CMD.alignCenter,
    CMD.boldOn,
    CMD.sizeDoubleBoth,
    line('PRUEBA'),
    CMD.sizeNormal,
    CMD.boldOff,
    line('Abarrotes "El Paisa"'),
    CMD.alignLeft,
    line(rule()),
    line('Acentos: áéíóú ÁÉÍÓÚ ñÑ üÜ ¿¡'),
    line(rule('=')),
    line(columns('32 columnas', 'derecha')),
    line(columns('PIÑA KG', money(3950))),
    line(rule()),
    CMD.boldOn,
    CMD.sizeDoubleHeight,
    line(columns('TOTAL', money(15600))),
    CMD.sizeNormal,
    CMD.boldOff,
    line(rule()),
    CMD.alignCenter,
    line('Si lees esto, funciona.'),
    CMD.feed(3),
    CMD.cut,
  ])
}

/**
 * The corte ticket: the slip the cashier tears off when they hand over the cash.
 * It states the period it covers, because "$2,340" on its own is unauditable a
 * week later when three cortes were taken the same day.
 */
function buildCorte(corte, storeName = 'Abarrotes "El Paisa"') {
  return Buffer.concat([
    CMD.init,
    CMD.codepagePC850,
    CMD.alignCenter,
    CMD.boldOn,
    CMD.sizeDoubleBoth,
    line('CORTE'),
    CMD.sizeNormal,
    line(storeName.length > 32 ? 'EL PAISA' : storeName),
    CMD.boldOff,
    CMD.alignLeft,
    line(rule()),
    line(columns('DESDE', timestamp(corte.openedAt))),
    line(columns('HASTA', timestamp(corte.createdAt))),
    line(columns('VENTAS', String(corte.saleCount))),
    line(rule()),
    CMD.boldOn,
    CMD.sizeDoubleHeight,
    line(columns('EFECTIVO', money(corte.totalCents), WIDTH)),
    CMD.sizeNormal,
    CMD.boldOff,
    line(rule()),
    line(''),
    line('Entrega: ______________________'),
    line(''),
    line('Recibe:  ______________________'),
    CMD.alignCenter,
    line(`Folio ${String(corte.uuid ?? '').slice(0, 8)}`),
    CMD.feed(3),
    CMD.cut,
  ])
}

module.exports = { buildReceipt, buildTestPage, buildCorte, WIDTH, columns, money, encode, text }
