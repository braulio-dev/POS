import { useEffect, useState } from 'react'
import { formatMoney } from '../lib/money'
import { methodLabel, terminalLabel, type Tender } from '../lib/tender'
import { pos } from '../lib/api'

interface Props {
  totalCents: number
  tender: Tender
  /** The sale just recorded, so its ticket can be printed again from here. */
  saleUuid: string
  onDismiss: () => void
}

export function ChangeScreen({ totalCents, tender, saleUuid, onDismiss }: Props) {
  const [printing, setPrinting] = useState(false)
  const [printNote, setPrintNote] = useState<string | null>(null)

  /**
   * Reprinting from the change screen.
   *
   * This is where a missing ticket is noticed — the printer was out of paper,
   * or the customer decides at the last second that they want one — and it is
   * the only moment when the cashier still knows exactly which sale it was
   * without going looking. So the button lives here as well as on the tickets
   * screen, and it prints from the database like every other reprint.
   */
  async function reprint(event: React.MouseEvent) {
    // The whole screen dismisses on a click, which is what makes it fast to
    // clear. A button inside it therefore has to stop the click reaching it, or
    // the ticket prints into a screen that has already gone.
    event.stopPropagation()
    setPrinting(true)
    const result = await pos.reprintReceipt(saleUuid)
    setPrinting(false)
    setPrintNote(result.ok ? 'Ticket impreso' : result.error ?? 'No se pudo imprimir')
  }
  // Any key or click clears it — the cashier is counting bills, not hunting for
  // a close button. No auto-dismiss timer: it stays until they say they're done.
  useEffect(() => {
    const handler = () => onDismiss()
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onDismiss])

  const paidByCard = tender.cardCents > 0

  return (
    <div className="change-screen" onClick={onDismiss}>
      {/*
        A card sale has no change to give, and showing a giant "0" on the screen
        the cashier reads at arm's length is how a customer gets waved off
        without their change on the *next* sale. So the headline says what
        actually happened instead.
      */}
      {/* On a cash sale the label is a caption over a huge number. A card sale
          has no number, so the label itself has to carry the screen and is set
          large instead. */}
      <h2 className={`change-title${tender.method === 'card' ? ' change-title-lead' : ''}`}>
        {tender.method === 'card' ? 'PAGADO CON TARJETA' : 'CAMBIO'}
      </h2>
      {tender.method !== 'card' && <p className="change-value">{formatMoney(tender.changeCents)}</p>}

      {paidByCard && (
        <p className="change-terminal">
          {formatMoney(tender.cardCents)} en la terminal
          {terminalLabel(tender.terminal) ? ` · ${terminalLabel(tender.terminal)}` : ''}
        </p>
      )}

      <dl className="change-summary">
        <div>
          <dt>TOTAL</dt>
          <dd>{formatMoney(totalCents)}</dd>
        </div>
        <div>
          <dt>PAGO</dt>
          <dd>{methodLabel(tender.method)}</dd>
        </div>
        {tender.method !== 'card' && (
          <div>
            <dt>RECIBIDO</dt>
            <dd>{formatMoney(tender.receivedCents)}</dd>
          </div>
        )}
      </dl>

      <button
        className="btn-secondary change-reprint"
        onClick={reprint}
        disabled={printing}
      >
        {printing ? 'IMPRIMIENDO…' : 'IMPRIMIR TICKET'}
      </button>
      {printNote && <p className="change-print-note">{printNote}</p>}

      <p className="change-hint">Toca la pantalla para continuar</p>
    </div>
  )
}
