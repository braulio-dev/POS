import { useCallback, useEffect, useRef, useState } from 'react'
import { formatMoney, parseAmount } from '../lib/money'
import {
  emptyDraft, validateTender, type PaymentDraft, type PaymentMethod, type Tender,
} from '../lib/tender'
import type { TerminalState } from '../types'
import { pos } from '../lib/api'

interface Props {
  totalCents: number
  /** '1' while the store takes cards at all. Off collapses this to the old cash-only screen. */
  terminalEnabled: boolean
  onConfirm: (tender: Tender) => void
  onCancel: () => void
}

const METHODS: { id: PaymentMethod; label: string; hint: string }[] = [
  { id: 'cash', label: 'EFECTIVO', hint: 'Billetes y monedas' },
  { id: 'card', label: 'TARJETA', hint: 'Todo en la terminal' },
  { id: 'mixed', label: 'MIXTO', hint: 'Una parte de cada uno' },
]

const BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'OTRA']

/** How often a pushed charge is re-checked while the customer is paying. */
const POLL_MS = 2000

export function PaymentModal({ totalCents, terminalEnabled, onConfirm, onCancel }: Props) {
  const [draft, setDraft] = useState<PaymentDraft>(() => emptyDraft())
  const [error, setError] = useState<string | null>(null)
  const [terminalState, setTerminalState] = useState<TerminalState | null>(null)
  // Set while a pushed charge is in flight, so the screen can show progress and
  // offer to give up without leaving the terminal waiting forever.
  const [charging, setCharging] = useState(false)
  const [chargeNote, setChargeNote] = useState<string | null>(null)

  const cashRef = useRef<HTMLInputElement>(null)
  const cardAmountRef = useRef<HTMLInputElement>(null)
  const authRef = useRef<HTMLInputElement>(null)

  const { method, terminal } = draft

  useEffect(() => { pos.getTerminalStatus().then(setTerminalState) }, [])

  // Pushing the amount to the terminal is only possible when it is configured
  // for it; otherwise every card sale is captured by hand off the printed slip.
  const autoCharge = Boolean(terminalState?.autoCharge)

  /* ------------------------------------------------------------- focus */

  // The cashier's hands are on the keyboard, not the mouse. Focus whichever
  // field this method actually starts with, so they can type straight away.
  useEffect(() => {
    if (method === 'cash') cashRef.current?.focus()
    else if (method === 'mixed') cardAmountRef.current?.focus()
    else if (!autoCharge) authRef.current?.focus()
  }, [method, autoCharge])

  const patch = useCallback((changes: Partial<PaymentDraft>) => {
    setDraft((prev) => ({ ...prev, ...changes }))
    setError(null)
  }, [])

  const patchTerminal = useCallback((changes: Partial<PaymentDraft['terminal']>) => {
    setDraft((prev) => ({ ...prev, terminal: { ...prev.terminal, ...changes } }))
    setError(null)
  }, [])

  /* ---------------------------------------------------- the amount on the card */

  // What is going on the terminal right now, so the cash leg below it can be
  // shown live rather than only revealed when the cashier presses COBRAR.
  const cardCents = method === 'card'
    ? totalCents
    : method === 'mixed'
      ? Math.min(parseAmount(draft.cardRaw) ?? 0, totalCents)
      : 0
  const cashCents = totalCents - cardCents

  /* ------------------------------------------------------- pushed charges */

  /**
   * Sends the amount to the terminal and watches it until the customer is done.
   *
   * A failure to start is not an error the cashier has to resolve: the screen
   * quietly drops to manual capture, they charge on the terminal's keypad as
   * usual, and the sale still closes. That is the whole reason the manual
   * fields never go away.
   */
  const startCharge = useCallback(async () => {
    if (cardCents <= 0) return
    setCharging(true)
    setChargeNote('Enviando a la terminal…')
    setError(null)

    const started = await pos.terminalCharge({
      amountCents: cardCents,
      // Ties the charge to this attempt in the vendor's dashboard. There is no
      // sale uuid yet — the sale is deliberately not recorded until the money
      // has actually moved.
      reference: `venta-${Date.now()}`,
    })

    if (!started.ok || !started.intentId) {
      setCharging(false)
      setChargeNote(`${started.reason ?? 'No se pudo usar la terminal'} — captura los datos a mano`)
      return
    }

    patchTerminal({ intentId: started.intentId, provider: started.provider, status: 'pending' })
    setChargeNote('Esperando al cliente en la terminal…')
  }, [cardCents, patchTerminal])

  // Polls the charge in flight. Cleared on unmount so a modal closed mid-charge
  // does not leave a timer running against a sale that no longer exists.
  useEffect(() => {
    if (!charging || !terminal.intentId) return
    let live = true

    const id = window.setInterval(async () => {
      const result = await pos.terminalPoll(terminal.intentId as string)
      if (!live) return
      if (!result.final) {
        if (result.reason) setChargeNote(`Reintentando… (${result.reason})`)
        return
      }

      setCharging(false)
      if (result.status === 'approved') {
        patchTerminal({
          status: 'approved',
          reference: result.reference ?? null,
          cardBrand: result.cardBrand ?? null,
          cardLast4: result.cardLast4 ?? null,
        })
        setChargeNote('Cobro aprobado')
      } else {
        patchTerminal({ status: result.status ?? 'error' })
        setChargeNote(
          result.status === 'declined' ? 'La tarjeta fue rechazada' : 'El cobro no se completó'
        )
      }
    }, POLL_MS)

    return () => { live = false; window.clearInterval(id) }
  }, [charging, terminal.intentId, patchTerminal])

  async function abandonCharge() {
    if (terminal.intentId) await pos.terminalCancel(terminal.intentId)
    setCharging(false)
    setChargeNote('Cobro cancelado — puedes capturarlo a mano')
    patchTerminal({ status: 'pending', intentId: null })
  }

  /* ---------------------------------------------------------------- submit */

  function submit() {
    const result = validateTender(totalCents, draft)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onConfirm(result.tender)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') requestCancel()
  }

  /**
   * Switching method resets the terminal record.
   *
   * Going card → cash → card must not silently carry an approval from the first
   * attempt onto the second: that would record an authorisation number for a
   * charge that never happened.
   */
  function chooseMethod(next: PaymentMethod) {
    if (charging) return
    setChargeNote(null)
    setDraft((prev) => ({ ...emptyDraft(), method: next, receivedRaw: prev.receivedRaw }))
    setError(null)
  }

  const needsCard = cardCents > 0
  const approved = terminal.status === 'approved'

  /**
   * Backing out of a payment screen that already holds an approved charge.
   *
   * This is the one way the terminal and the register can end up disagreeing:
   * the money has genuinely moved at the card processor, and abandoning the
   * screen would leave no sale to account for it. Clip will still deposit it;
   * the shop's own books will not know why.
   *
   * The baseline below is the cautious reading — confirm before discarding, so
   * it can never happen by a stray click on the backdrop.
   *
   * TODO(you): decide what the store should actually do here. The options are
   * genuinely different, and which is right depends on how much you trust the
   * counter:
   *
   *   a) Confirm and discard (what it does now). Simple, but the charge is left
   *      for someone to refund on the Clip app later, and nothing reminds them.
   *   b) Refuse outright — an approved charge must become a sale. Safest for the
   *      books, but strands the cashier if the customer walks off mid-sale.
   *   c) Try to cancel/void the charge on the terminal first (terminal.cancel
   *      only works while it is still pending, so this needs a refund call the
   *      drivers do not have yet), and only discard if that succeeds.
   *
   * Whatever you pick, the cashier needs to end up knowing that real money is
   * sitting on the terminal with no sale behind it.
   */
  function requestCancel() {
    if (charging) return
    if (approved && cardCents > 0) {
      const sure = window.confirm(
        `La terminal ya aprobó ${formatMoney(cardCents)}. Si sales ahora, ese cobro ` +
        `queda hecho pero sin venta registrada. ¿Salir de todos modos?`
      )
      if (!sure) return
    }
    onCancel()
  }

  return (
    <div className="modal-backdrop" onMouseDown={requestCancel}>
      <div className="modal payment-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="payment-total">
          <span>TOTAL</span>
          <strong>{formatMoney(totalCents)}</strong>
        </div>

        {terminalEnabled && (
          <div className="payment-methods" role="group" aria-label="Forma de pago">
            {METHODS.map((m) => (
              <button
                key={m.id}
                type="button"
                className="payment-method"
                aria-pressed={method === m.id}
                disabled={charging}
                onClick={() => chooseMethod(m.id)}
              >
                <span className="payment-method-label">{m.label}</span>
                <span className="payment-method-hint">{m.hint}</span>
              </button>
            ))}
          </div>
        )}

        {/* ------------------------------------------------ the card leg */}

        {needsCard && (
          <div className="payment-card">
            {method === 'mixed' && (
              <div className="payment-row">
                <label className="payment-label" htmlFor="card-amount">TARJETA</label>
                <input
                  id="card-amount"
                  ref={cardAmountRef}
                  className="text-input payment-input"
                  placeholder="CANTIDAD"
                  inputMode="decimal"
                  value={draft.cardRaw}
                  disabled={charging}
                  onChange={(e) => patch({ cardRaw: e.target.value })}
                  onKeyDown={onKey}
                />
              </div>
            )}

            {autoCharge ? (
              <div className="payment-terminal-push">
                {!approved && !charging && (
                  <button type="button" className="btn-secondary" onClick={startCharge}>
                    ENVIAR {formatMoney(cardCents)} A LA TERMINAL
                  </button>
                )}
                {charging && (
                  <button type="button" className="btn-secondary" onClick={abandonCharge}>
                    CANCELAR COBRO
                  </button>
                )}
              </div>
            ) : null}

            {/*
              Manual capture. Always present — even in push mode — because a
              terminal that times out, or a charge the cashier ran on its keypad
              while the register was thinking, still has to be recordable.
              Filling in the authorisation number IS the approval: it is printed
              on the terminal's slip and cannot be invented from this screen.
            */}
            <div className="payment-row">
              <label className="payment-label" htmlFor="auth">AUTORIZACIÓN</label>
              <input
                id="auth"
                ref={authRef}
                className="text-input payment-input"
                placeholder="Nº DEL COMPROBANTE"
                value={terminal.reference ?? ''}
                onChange={(e) => {
                  const reference = e.target.value
                  patchTerminal({
                    reference,
                    // Typing the code off the slip is the cashier asserting the
                    // terminal approved it. Clearing it withdraws that.
                    status: reference.trim() ? 'approved' : 'pending',
                  })
                }}
                onKeyDown={onKey}
              />
            </div>

            <div className="payment-card-details">
              <label className="field">
                <span>MARCA</span>
                <select
                  className="text-input"
                  value={terminal.cardBrand ?? ''}
                  onChange={(e) => patchTerminal({ cardBrand: e.target.value || null })}
                >
                  <option value="">—</option>
                  {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>

              <label className="field">
                <span>ÚLTIMOS 4</span>
                <input
                  className="text-input"
                  placeholder="0000"
                  inputMode="numeric"
                  maxLength={4}
                  value={terminal.cardLast4 ?? ''}
                  onChange={(e) =>
                    patchTerminal({ cardLast4: e.target.value.replace(/\D/g, '').slice(0, 4) || null })
                  }
                  onKeyDown={onKey}
                />
              </label>
            </div>

            {chargeNote && <p className="payment-note">{chargeNote}</p>}
          </div>
        )}

        {/* ------------------------------------------------ the cash leg */}

        {cashCents > 0 && (
          <>
            {method === 'mixed' && (
              <p className="payment-note">
                Falta cobrar <strong>{formatMoney(cashCents)}</strong> en efectivo
              </p>
            )}
            <div className="payment-row">
              <label className="payment-label" htmlFor="recibido">RECIBIDO</label>
              <input
                id="recibido"
                ref={cashRef}
                className="text-input payment-input"
                placeholder="CANTIDAD"
                inputMode="decimal"
                value={draft.receivedRaw}
                onChange={(e) => patch({ receivedRaw: e.target.value })}
                onKeyDown={onKey}
              />
            </div>
          </>
        )}

        {error && <p className="field-error">{error}</p>}

        <button
          className="btn-cobrar payment-cobrar"
          onClick={submit}
          // Blocked while the customer is still at the terminal: pressing COBRAR
          // then would record money that has not moved yet.
          disabled={charging}
        >
          COBRAR
        </button>
      </div>
    </div>
  )
}
