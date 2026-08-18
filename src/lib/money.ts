/**
 * Money is stored and computed in integer cents, never floats.
 * 0.1 + 0.2 === 0.30000000000000004 in JavaScript; a till that drifts by a
 * centavo per sale is a till that never reconciles at closing time.
 */

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Compact form for dense rows: "56" instead of "$56.00" when it's a whole peso. */
export function formatShort(cents: number): string {
  return cents % 100 === 0 ? String(Math.round(cents / 100)) : formatMoney(cents).slice(1)
}

/** Parses user input ("56", "56.5", "56,50") into cents. Returns null if unparseable. */
export function parseAmount(input: string): number | null {
  const cleaned = input.trim().replace(/\s/g, '').replace(',', '.')
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100)
}
