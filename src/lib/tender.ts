import { parseAmount } from './money'

/**
 * How the money for a sale arrived.
 *
 *   cash   all of it in bills and coins
 *   card   all of it through the terminal (Clip / Mercado Pago Point)
 *   mixed  part cash, part terminal — common when a card is declined partway,
 *          or when the customer wants to break a large bill
 *
 * This is a *label*, not the source of truth. The truth is the cashCents /
 * cardCents split below, which must always add up to the sale total. Deriving
 * the label from the split (rather than the other way round) is what keeps the
 * corte honest: there is no way to record "card" and still have the drawer
 * think it gained money.
 */
export type PaymentMethod = 'cash' | 'card' | 'mixed'

/** Where a terminal charge stands. Only `approved` may complete a sale. */
export type TerminalStatus = 'approved' | 'pending' | 'declined' | 'canceled' | 'error'

/**
 * What the terminal told us about one charge.
 *
 * `reference` is the authorisation number printed on the terminal's own slip.
 * It is the only field the store can take to Clip when a customer disputes a
 * charge, so it is required on any card tender — see `validateTender`.
 */
export interface TerminalDetails {
  /** 'manual' when the cashier read it off the terminal, otherwise the driver id. */
  provider: string
  reference: string | null
  cardBrand: string | null
  cardLast4: string | null
  status: TerminalStatus
  /** Set by the cloud drivers so a pending charge can be polled or cancelled. */
  intentId?: string | null
}

/** What the payment screen holds while the cashier is typing. */
export interface PaymentDraft {
  method: PaymentMethod
  /** Cash physically handed over. Ignored on a pure card sale. */
  receivedRaw: string
  /** Amount put on the terminal. Only typed on a mixed tender; card = the total. */
  cardRaw: string
  terminal: TerminalDetails
}

/** A validated tender, ready to be recorded. */
export interface Tender {
  method: PaymentMethod
  /** Cash that stays in the drawer. Total minus change, never the amount handed over. */
  cashCents: number
  /** Charged through the terminal. */
  cardCents: number
  /** Bills and coins handed over. 0 on a pure card sale. */
  receivedCents: number
  changeCents: number
  terminal: TerminalDetails | null
}

export type TenderResult =
  | { ok: true; tender: Tender }
  | { ok: false; error: string }

export const emptyTerminal = (provider = 'manual'): TerminalDetails => ({
  provider,
  reference: null,
  cardBrand: null,
  cardLast4: null,
  status: 'pending',
  intentId: null,
})

export const emptyDraft = (provider = 'manual'): PaymentDraft => ({
  method: 'cash',
  receivedRaw: '',
  cardRaw: '',
  terminal: emptyTerminal(provider),
})

/**
 * Decides whether what the cashier entered is acceptable, and how much change
 * is owed.
 *
 * This is a policy decision, not just arithmetic — see the TODO below.
 * The baseline is the strictest reading: amounts must parse, must be positive,
 * cash must cover its share, and a card leg must carry an approval from the
 * terminal before the sale is allowed to close.
 */
export function validateTender(totalCents: number, draft: PaymentDraft): TenderResult {
  const { method, terminal } = draft

  /* ------------------------------------------------------------- card leg */

  // How much is going on the terminal. A pure card sale puts the whole total
  // there without asking; a mixed one takes the number the cashier typed.
  let cardCents = 0
  if (method === 'card') {
    cardCents = totalCents
  } else if (method === 'mixed') {
    const parsed = parseAmount(draft.cardRaw)
    if (parsed === null) return { ok: false, error: 'Cantidad de terminal inválida' }
    if (parsed <= 0) return { ok: false, error: 'Ingresa cuánto va en la terminal' }
    if (parsed >= totalCents) {
      // Not an error worth blocking on so much as the wrong screen: if the card
      // covers everything, this is a card sale and should be recorded as one.
      return { ok: false, error: 'La terminal cubre todo — usa TARJETA' }
    }
    cardCents = parsed
  }

  if (cardCents > 0) {
    // The register must never record money it cannot prove arrived. An unapproved
    // charge with no authorisation number is exactly the sale that turns into an
    // unwinnable dispute three weeks later.
    if (terminal.status !== 'approved') {
      return { ok: false, error: 'La terminal aún no aprueba el cobro' }
    }
    if (!terminal.reference || !terminal.reference.trim()) {
      return { ok: false, error: 'Falta el número de autorización de la terminal' }
    }
  }

  /* ------------------------------------------------------------- cash leg */

  const cashCents = totalCents - cardCents

  // A pure card sale takes no cash, so there is nothing to validate and nothing
  // to give back.
  if (cashCents === 0) {
    return {
      ok: true,
      tender: { method: 'card', cashCents: 0, cardCents, receivedCents: 0, changeCents: 0, terminal },
    }
  }

  const receivedCents = parseAmount(draft.receivedRaw)
  if (receivedCents === null) return { ok: false, error: 'Cantidad inválida' }
  if (receivedCents <= 0) return { ok: false, error: 'Ingresa una cantidad' }

  // TODO(you): shape the real rules for the store. Things worth deciding:
  //
  //   1. Underpayment. Right now anything below the cash leg is rejected
  //      outright. Should a short amount be allowed (partial payment / "te lo
  //      fío"), or is hard rejection correct for a small cash store?
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
  if (receivedCents < cashCents) {
    return { ok: false, error: 'Cantidad insuficiente' }
  }

  return {
    ok: true,
    tender: {
      method: cardCents > 0 ? 'mixed' : 'cash',
      cashCents,
      cardCents,
      receivedCents,
      changeCents: receivedCents - cashCents,
      terminal: cardCents > 0 ? terminal : null,
    },
  }
}

/* ------------------------------------------------------------- presentation */

/** Short Spanish label for a method. Used on receipts, cortes and the admin UI. */
export function methodLabel(method: PaymentMethod): string {
  return method === 'card' ? 'TARJETA' : method === 'mixed' ? 'MIXTO' : 'EFECTIVO'
}

/** "VISA ••4321 · aut. 004417" — what the owner needs to chase a disputed charge. */
export function terminalLabel(t: TerminalDetails | null): string {
  if (!t) return ''
  const brand = [t.cardBrand, t.cardLast4 ? `••${t.cardLast4}` : null].filter(Boolean).join(' ')
  const ref = t.reference ? `aut. ${t.reference}` : null
  return [brand || null, ref].filter(Boolean).join(' · ')
}
