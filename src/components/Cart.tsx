import type { CartLine } from '../types'
import { formatShort } from '../lib/money'

interface Props {
  lines: CartLine[]
  totalCents: number
  onRemove: (index: number) => void
}

export function Cart({ lines, totalCents, onRemove }: Props) {
  return (
    <aside className="cart-pane">
      <div className="cart-lines">
        {lines.map((line, i) => (
          <button key={i} className="cart-row" onClick={() => onRemove(i)} title={`Quitar uno — ${line.name}`}>
            {/* The name truncates, the quantity never does: "GALLETAS MARIA…" is
                still readable, but a clipped "x6" would misprice the sale in the
                cashier's head. So they are separate elements, and only the name
                is allowed to shrink. */}
            <span className="cart-name">
              <span className="cart-name-text">{line.name}</span>
              {line.qty > 1 && <em className="cart-qty">×{line.qty}</em>}
            </span>
            <span className="cart-amount">{formatShort(line.unitPriceCents * line.qty)}</span>
          </button>
        ))}
      </div>

      <div className="cart-total">
        <span className="cart-name">
          <span className="cart-name-text">TOTAL</span>
        </span>
        <span className="cart-amount">{formatShort(totalCents)}</span>
      </div>
    </aside>
  )
}
