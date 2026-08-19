import type { CartLine } from '../types'
import { formatMoney } from '../lib/money'
import { formatKg } from '../lib/weight'

interface Props {
  lines: CartLine[]
  totalCents: number
  onRemove: (index: number) => void
  onCorte: () => void
  onCobrar: () => void
}

export function Cart({ lines, totalCents, onRemove, onCorte, onCobrar }: Props) {
  // Weight lines count as one article each. Adding 1.35 to a count of pieces
  // would print "3.35 artículos" in the header, which is not a thing.
  const itemCount = lines.reduce((sum, l) => sum + (l.unit === 'kg' ? 1 : l.qty), 0)

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
          <button
            key={i}
            className="cart-row"
            onClick={() => onRemove(i)}
            // A weighed line has no "one" to take off — half a kilo of frijol is
            // one weighing, and the only sensible undo is to remove it and weigh
            // again. The tooltip says which of the two this row does.
            title={line.unit === 'kg' ? `Quitar — ${line.name}` : `Quitar uno — ${line.name}`}
          >
            {/* The name truncates, the quantity never does: "GALLETAS MARIA…" is
                still readable, but a clipped "x6" would misprice the sale in the
                cashier's head. So they are separate elements, and only the name
                is allowed to shrink. */}
            <span className="cart-name">
              <span className="cart-name-text">{line.name}</span>
              {line.unit === 'kg' ? (
                <em className="cart-qty cart-qty-kg">{formatKg(line.qty)}</em>
              ) : (
                line.qty > 1 && <em className="cart-qty">× {line.qty}</em>
              )}
            </span>
            {/* The line's own total, not price × qty recomputed here: a weighed
                line was rounded to the centavo once when it was added, and this
                column has to agree with the ticket that gets printed. */}
            <span className="cart-amount">{formatMoney(line.lineTotalCents)}</span>
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
