import { parseAmount } from './money'

export type TenderResult =
  | { ok: true; receivedCents: number; changeCents: number }
  | { ok: false; error: string }

/**
 * Decides whether the cash the cashier typed into RECIBIDO is acceptable,
 * and how much change is owed.
 *
 * This is a policy decision, not just arithmetic — see the TODO below.
 * The baseline here is the strictest reading: the amount must parse, must be
 * positive, and must cover the total exactly or with change owed.
 */
export function validateTender(totalCents: number, rawInput: string): TenderResult {
  const receivedCents = parseAmount(rawInput)

  if (receivedCents === null) return { ok: false, error: 'Cantidad inválida' }
  if (receivedCents <= 0) return { ok: false, error: 'Ingresa una cantidad' }

  // TODO(you): shape the real rules for the store. Things worth deciding:
  //
  //   1. Underpayment. Right now anything below the total is rejected outright.
  //      Should a short amount be allowed (partial payment / "te lo fío"), or is
  //      hard rejection correct for a small cash store?
  //
  //   2. Implausible amounts. A cashier meaning 200 who types 2000 gets told to
  //      hand over $1,844 in change. Worth warning when received is, say, more
  //      than 10x the total? Warn, or block?
  //
  //   3. Cash rounding. Mexico dropped the 10¢ and 20¢ coins from circulation.
  //      If a total ends in .07, should change round to the nearest 50¢ so the
  //      drawer can actually pay it out — and if so, which way?
  //
  //   4. Zero-total sales. Should COBRAR even be reachable with an empty cart?
  //      (The COBRAR button is already disabled when the cart is empty, so this
  //      only matters if a discount ever brings a real cart to zero.)
  //
  if (receivedCents < totalCents) {
    return { ok: false, error: 'Cantidad insuficiente' }
  }

  return { ok: true, receivedCents, changeCents: receivedCents - totalCents }
}
