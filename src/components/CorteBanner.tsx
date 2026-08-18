import { formatMoney } from '../lib/money'
import type { CashDrawer } from '../types'

interface Props {
  drawer: CashDrawer
  onCorte: () => void
}

/**
 * The corte reminder.
 *
 * It sits in the flow of the page rather than floating, so it physically pushes
 * the till down a few pixels — impossible to keep working past without noticing,
 * which is the whole point. It is not dismissible: the only way to make it go
 * away is to take the cash out, which is exactly the behaviour we want.
 */
export function CorteBanner({ drawer, onCorte }: Props) {
  return (
    <div className="corte-banner" role="status">
      <span className="corte-banner-dot" aria-hidden="true" />
      <div className="corte-banner-text">
        <strong>HAY QUE HACER CORTE</strong>
        <span className="corte-banner-detail">
          {formatMoney(drawer.totalCents)} en caja · {drawer.saleCount}{' '}
          {drawer.saleCount === 1 ? 'venta' : 'ventas'}
        </span>
      </div>
      <button className="btn-corte" onClick={onCorte}>HACER CORTE</button>
    </div>
  )
}
