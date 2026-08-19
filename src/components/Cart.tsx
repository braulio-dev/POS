import type { CartLine } from '../types'
import { formatMoney } from '../lib/money'

interface Props {
  lines: CartLine[]
  totalCents: number
  onRemove: (index: number) => void
  onCorte: () => void
  onCobrar: () => void
}

export function Cart({ lines, totalCents, onRemove, onCorte, onCobrar }: Props) {
  const itemCount = lines.reduce((sum, l) => sum + l.qty, 0)

  return (
    <aside className="cart-pane">
      <div className="ticket-head">
        <span className="ticket-title">Ticket</span>
        {itemCount > 0 && (
          <span className="ticket-count">
            {itemCount} {itemCount === 1 ? 'artículo' : 'artículos'}
          </span>
        )}
      </div>

      <div className="cart-lines">
        {lines.map((line, i) => (
          <button key={i} className="cart-row" onClick={() => onRemove(i)} title={`Quitar uno — ${line.name}`}>
            {/* The name truncates, the quantity never does: "GALLETAS MARIA…" is
                still readable, but a clipped "x6" would misprice the sale in the
                cashier's head. So they are separate elements, and only the name
                is allowed to shrink. */}
            <span className="cart-name">
              <span className="cart-name-text">{line.name}</span>
              {line.qty > 1 && <em className="cart-qty">× {line.qty}</em>}
            </span>
            <span className="cart-amount">{formatMoney(line.unitPriceCents * line.qty)}</span>
          </button>
        ))}
      </div>

      <div className="cart-total">
        <span>Total</span>
        <span className="cart-amount">{formatMoney(totalCents)}</span>
      </div>

      {/*
        Both actions live at the foot of the ticket, where the cashier's hand
        already is. CORTE keeps a third of the width against COBRAR's two: it is
        pressed a handful of times a day against COBRAR's every sale, and the
        size difference is what stops a hand reaching for one finding the other.

        CORTE is always available, unlike the banner, which only appears once the
        drawer crosses the threshold. Shift changes and errands do not wait for a
        peso amount.
      */}
      <div className="ticket-actions">
        <button className="btn-corte" onClick={onCorte}>CORTE</button>
        <button className="btn-cobrar" disabled={lines.length === 0} onClick={onCobrar}>
          COBRAR
        </button>
      </div>
    </aside>
  )
}
