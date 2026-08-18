import { useEffect } from 'react'
import { formatShort } from '../lib/money'
import { methodLabel, terminalLabel, type Tender } from '../lib/tender'

interface Props {
  totalCents: number
  tender: Tender
  onDismiss: () => void
}

export function ChangeScreen({ totalCents, tender, onDismiss }: Props) {
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
      <h2 className="change-title">{tender.method === 'card' ? 'PAGADO CON TARJETA' : 'CAMBIO'}</h2>
      {tender.method !== 'card' && <p className="change-value">{formatShort(tender.changeCents)}</p>}

      {paidByCard && (
        <p className="change-terminal">
          {formatShort(tender.cardCents)} en la terminal
          {terminalLabel(tender.terminal) ? ` · ${terminalLabel(tender.terminal)}` : ''}
        </p>
      )}

      <dl className="change-summary">
        <div>
          <dt>TOTAL</dt>
          <dd>{formatShort(totalCents)}</dd>
        </div>
        <div>
          <dt>PAGO</dt>
          <dd>{methodLabel(tender.method)}</dd>
        </div>
        {tender.method !== 'card' && (
          <div>
            <dt>RECIBIDO</dt>
            <dd>{formatShort(tender.receivedCents)}</dd>
          </div>
        )}
      </dl>

      <p className="change-hint">Toca la pantalla para continuar</p>
    </div>
  )
}
