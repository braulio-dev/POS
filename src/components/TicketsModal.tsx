import { useEffect, useState } from 'react'
import type { SaleRecord } from '../types'
import { formatMoney } from '../lib/money'
import { formatQty } from '../lib/weight'
import { methodLabel } from '../lib/tender'
import { pos } from '../lib/api'

interface Props {
  onClose: () => void
  onToast: (message: string) => void
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('es-MX', { timeStyle: 'short' })
    : d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * Recent sales, each with a REIMPRIMIR button.
 *
 * The register has always been able to survive a dead printer — the sale
 * commits before anything is spooled — but until now surviving it cost the
 * ticket permanently. This is the other half of that promise: the sale is in
 * SQLite, so the paper can be produced again whenever the printer comes back.
 *
 * Reprinting takes only a uuid. The slip is rebuilt in the main process from
 * what was recorded, so a copy cannot show anything the sale does not say, and
 * it comes out stamped COPIA so it cannot be handed over as a second sale.
 *
 * Not behind the owner's password: the cashier is the one standing in front of
 * the customer who wants their ticket, and a reprint changes no money.
 */
export function TicketsModal({ onClose, onToast }: Props) {
  const [sales, setSales] = useState<SaleRecord[] | null>(null)
  const [printing, setPrinting] = useState<string | null>(null)

  useEffect(() => { pos.listRecentSales(30).then(setSales) }, [])

  async function reprint(sale: SaleRecord) {
    setPrinting(sale.uuid)
    const result = await pos.reprintReceipt(sale.uuid)
    setPrinting(null)
    onToast(result.ok ? 'Ticket reimpreso' : result.error ?? 'No se pudo imprimir')
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal tickets-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Tickets recientes</h2>

        <div className="tickets-scroll">
          {sales === null ? (
            <p className="muted-note">Cargando…</p>
          ) : sales.length === 0 ? (
            <p className="muted-note">Todavía no hay ventas registradas.</p>
          ) : (
            sales.map((sale) => (
              <div key={sale.uuid} className="ticket-card">
                <div className="ticket-card-head">
                  <span className="ticket-when">{when(sale.createdAt)}</span>
                  <span className={`pay-badge pay-${sale.paymentMethod}`}>
                    {methodLabel(sale.paymentMethod)}
                  </span>
                  <strong className="ticket-total">{formatMoney(sale.totalCents)}</strong>
                </div>

                <p className="ticket-items">
                  {sale.items.map((item, i) => (
                    <span key={i} className="ticket-item">
                      {item.name} {formatQty(item.qty, item.unit ?? 'pza')}
                    </span>
                  ))}
                </p>

                <button
                  className="btn-secondary ticket-reprint"
                  onClick={() => reprint(sale)}
                  disabled={printing !== null}
                >
                  {printing === sale.uuid ? 'IMPRIMIENDO…' : 'REIMPRIMIR'}
                </button>
              </div>
            ))
          )}
        </div>

        <p className="muted-note">
          La copia sale marcada <strong>COPIA</strong>, para que no se pueda
          confundir con una segunda venta.
        </p>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  )
}
