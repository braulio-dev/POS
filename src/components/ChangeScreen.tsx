import { useEffect } from 'react'
import { formatShort } from '../lib/money'

interface Props {
  totalCents: number
  receivedCents: number
  changeCents: number
  onDismiss: () => void
}

export function ChangeScreen({ totalCents, receivedCents, changeCents, onDismiss }: Props) {
  // Any key or click clears it — the cashier is counting bills, not hunting for
  // a close button. No auto-dismiss timer: it stays until they say they're done.
  useEffect(() => {
    const handler = () => onDismiss()
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onDismiss])

  return (
    <div className="change-screen" onClick={onDismiss}>
      <h2 className="change-title">CAMBIO</h2>
      <p className="change-value">{formatShort(changeCents)}</p>

      <dl className="change-summary">
        <div>
          <dt>TOTAL</dt>
          <dd>{formatShort(totalCents)}</dd>
        </div>
        <div>
          <dt>RECIBIDO</dt>
          <dd>{formatShort(receivedCents)}</dd>
        </div>
      </dl>

      <p className="change-hint">Toca la pantalla para continuar</p>
    </div>
  )
}
