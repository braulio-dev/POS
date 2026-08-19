import type { Product } from '../types'

/**
 * Selling by weight — sold "por kilo".
 *
 * The rule is deliberately the one the owner already understands: **anything
 * without Inventario is sold by the kilo.** There is no third switch to set and
 * no way for the two to disagree, because there is only one flag. A product
 * with the Inventario box ticked is counted in pieces and its price is the
 * price of one piece; unticked, it has no unit count to keep — which is exactly
 * the case for frijol, queso and jamón — and its price is the price of a kilo.
 *
 * That coupling is the whole feature: `track_stock = 0` already meant "this has
 * no pieces", and a thing with no pieces has to be measured some other way.
 */

/** Grams. Finer than any counter scale, and it keeps 1/3 kg honest. */
const DECIMALS = 3

/** Nothing sane weighs more than this; it catches a stuck scale key. */
const MAX_KG = 999

export type SaleUnit = 'pza' | 'kg'

export function isSoldByWeight(product: Pick<Product, 'track_stock'>): boolean {
  return !product.track_stock
}

export function unitOf(product: Pick<Product, 'track_stock'>): SaleUnit {
  return isSoldByWeight(product) ? 'kg' : 'pza'
}

const round3 = (n: number) => Math.round(n * 10 ** DECIMALS) / 10 ** DECIMALS

/** Parses "1.35", "1,35" or ".5" into kilos. Null when it isn't a weight. */
export function parseWeight(input: string): number | null {
  const cleaned = input.trim().replace(/\s/g, '').replace(',', '.')
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return null
  const kg = Number(cleaned)
  if (!Number.isFinite(kg) || kg <= 0 || kg > MAX_KG) return null
  return round3(kg)
}

/**
 * What a given weight costs.
 *
 * Rounded to the centavo exactly once, here, and then carried as the line's own
 * total. Re-deriving it later from `price × kg` would round a second time on a
 * different code path — and a receipt whose lines do not add up to the total
 * printed under them is the fastest way to lose a customer's trust at the
 * counter, whatever the arithmetic says.
 */
export function weightTotalCents(pricePerKgCents: number, kg: number): number {
  return Math.round(pricePerKgCents * kg)
}

/**
 * The other half of the counter conversation: "me da $50 de jamón".
 *
 * The customer named the money, so the money is exact and the weight is what
 * gets rounded — the scale will be off by a gram either way, and nobody has
 * ever argued about a gram. Doing it the other way round (weigh the implied
 * amount, then re-multiply) would hand back $49.98 for a $50 request.
 */
export function kgForAmount(pricePerKgCents: number, amountCents: number): number | null {
  if (pricePerKgCents <= 0 || amountCents <= 0) return null
  const kg = round3(amountCents / pricePerKgCents)
  return kg > 0 && kg <= MAX_KG ? kg : null
}

/** "1.350 kg" — always three decimals, so it reads like the scale's display. */
export function formatKg(kg: number): string {
  return `${kg.toFixed(DECIMALS)} kg`
}

/**
 * How a line names its quantity in a list.
 *
 * A single piece says nothing — "Papas × 1" is one word of noise per line in a
 * ticket list that is read at a glance — so it says nothing.
 */
export function formatQty(qty: number, unit: SaleUnit): string {
  if (unit === 'kg') return formatKg(qty)
  return qty === 1 ? '' : `× ${qty}`
}

/* ------------------------------------------------------------ scale labels */

/**
 * What the deli scale prints on its own labels.
 *
 * A scale that prints labels encodes the measurement into an EAN-13 beginning
 * with `2` — the range GS1 reserves for codes a shop assigns itself, which is
 * exactly what these are. Thirteen digits, in the common layout:
 *
 *     2X IIIII VVVVV C
 *     │  │     │     └ check digit
 *     │  │     └────── the measurement: grams, or centavos
 *     │  └──────────── the item code the scale was programmed with
 *     └─────────────── in-store flag, 20–29
 *
 * Which of the two `VVVVV` is depends on how the scale was set up, and no digit
 * in the label says which — so it is a setting rather than a guess. Reading a
 * price as a weight would sell 4.5 kg of ham to someone who asked for $45 of
 * it, so the wrong answer here is expensive and silence is better than a guess.
 * That is also why this is off until someone turns it on.
 *
 * The check digit is deliberately not verified. Scales disagree about how it is
 * computed — some follow EAN-13 over all twelve digits, others run their own
 * check over the price field alone — and rejecting a label the scanner read
 * perfectly well would send the cashier back to typing for no gain. A wrong
 * digit surfaces as an unknown item code, which the register already handles.
 */
export type ScaleMode = 'off' | 'weight' | 'price'

export interface ScaleLabel {
  /** The five digits identifying the product, as printed. */
  itemCode: string
  /** Flag and item code together — the label's first seven digits. */
  prefix: string
  /** Weight in kilos, when the scale encodes grams. */
  kg: number | null
  /** Amount in cents, when the scale encodes the price. */
  amountCents: number | null
}

export function parseScaleBarcode(code: string, mode: ScaleMode): ScaleLabel | null {
  if (mode === 'off') return null
  if (!/^2\d{12}$/.test(code)) return null

  const itemCode = code.slice(2, 7)
  const prefix = code.slice(0, 7)
  const value = Number(code.slice(7, 12))
  if (!Number.isFinite(value) || value <= 0) return null

  return mode === 'weight'
    ? { itemCode, prefix, kg: round3(value / 1000), amountCents: null }
    : { itemCode, prefix, kg: null, amountCents: value }
}

/**
 * Turns a decoded label into the line to add.
 *
 * Both modes end up carrying a weight and a price, because the ticket needs one
 * and the corte needs the other. Which of the two is exact follows from which
 * one the label actually stated: a weight label is authoritative about grams
 * and the price is computed from it; a price label is authoritative about pesos
 * — the customer asked for $45 of ham and the scale cut $45 of ham — and the
 * weight is what gets solved for, exactly like typing an importe by hand.
 */
export function scaleLine(
  label: ScaleLabel, pricePerKgCents: number
): { kg: number; totalCents: number } | null {
  if (label.kg !== null) {
    return { kg: label.kg, totalCents: weightTotalCents(pricePerKgCents, label.kg) }
  }
  if (label.amountCents !== null) {
    const kg = kgForAmount(pricePerKgCents, label.amountCents)
    return kg === null ? null : { kg, totalCents: label.amountCents }
  }
  return null
}
