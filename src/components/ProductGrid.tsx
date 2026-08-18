import type { Product } from '../types'
import { formatMoney } from '../lib/money'
import { stockLabel, stockLevel } from '../lib/stock'

interface Props {
  products: Product[]
  lowStockAt: number
  onSelect: (product: Product) => void
  onAdd: () => void
}

export function ProductGrid({ products, lowStockAt, onSelect, onAdd }: Props) {
  return (
    <section className="grid-pane">
      <div className="grid-scroll">
        {products.length === 0 ? (
          <p className="empty-grid">Sin productos todavía. Usa el botón + para agregar uno.</p>
        ) : (
          <div className="product-grid">
            {products.map((p) => {
              const level = stockLevel(p, lowStockAt)
              const label = stockLabel(level, p.stock)
              return (
                <button key={p.id} className="product-card" onClick={() => onSelect(p)}>
                  <div className="product-thumb">
                    {p.image_file ? (
                      <img src={`posimg://images/${p.image_file}`} alt="" draggable={false} />
                    ) : (
                      <span className="thumb-placeholder">{p.name.slice(0, 2).toUpperCase()}</span>
                    )}
                    {/* Only worth the ink when it is actionable: a healthy count
                        is noise on every card, an empty shelf is not. Goods sold
                        loose get no badge at all -- they have no unit count. */}
                    {label && (
                      <span
                        className={`stock-badge stock-${level}`}
                        title={level === 'over' ? 'Se vendio mas de lo registrado' : undefined}
                      >
                        {label}
                      </span>
                    )}
                  </div>
                  <span className="product-name">{p.name}</span>
                  <span className="product-price">{formatMoney(p.price_cents)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <button className="fab" onClick={onAdd} aria-label="Agregar producto" title="Agregar producto">
        +
      </button>
    </section>
  )
}
