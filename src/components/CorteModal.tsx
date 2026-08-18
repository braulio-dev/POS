import { useState } from 'react'
import { formatMoney } from '../lib/money'
import type { CashDrawer, Corte } from '../types'
import { pos } from '../lib/api'

interface Props {
  drawer: CashDrawer
  onDone: (corte: Corte, printed: { ok: boolean; error?: string }) => void
  onCancel: () => void
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  // The epoch is the sentinel for "no corte has ever been taken here".
  if (d.getFullYear() < 2000) return 'el inicio'
  return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
}

export function CorteModal({ drawer, onDone, onCancel }: Props) {
  const [working, setWorking] = useState(false)
  const [print, setPrint] = useState(true)
  const [cashier, setCashier] = useState('')

  // Who was on the till is the one thing about a corte nobody can reconstruct
  // afterwards: the amount and the period are in the database, the name only
  // ever exists in the room. So the cut will not go through without it.
  const named = cashier.trim().length > 0

  async function confirm() {
    if (!named) return
    setWorking(true)
    // The cut commits to SQLite inside the main process before anything is
    // spooled, so an out-of-paper printer costs a slip, never the record.
    const { corte, printed } = await pos.recordCorte({ print, cashier: cashier.trim() })
    onDone(corte, printed)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal product-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Corte de caja</h2>

        <dl className="corte-summary">
          <div>
            <dt>DESDE</dt>
            <dd>{shortTime(drawer.openedAt)}</dd>
          </div>
          <div>
            <dt>VENTAS</dt>
            <dd>{drawer.saleCount}</dd>
          </div>

          {/*
            The card rows only appear when there were card sales. On an all-cash
            day they would be two zeroes sitting above the number that matters,
            which is noise on the one screen that has to be read quickly.
          */}
          {drawer.cardCents > 0 && (
            <>
              <div>
                <dt>TOTAL VENDIDO</dt>
                <dd>{formatMoney(drawer.totalCents)}</dd>
              </div>
              <div>
                <dt>TARJETA ({drawer.cardSaleCount})</dt>
                <dd>{formatMoney(drawer.cardCents)}</dd>
              </div>
            </>
          )}

          <div className="corte-summary-total">
            <dt>EFECTIVO</dt>
            <dd>{formatMoney(drawer.cashCents)}</dd>
          </div>
        </dl>

        <p className="muted-note">
          Saca {formatMoney(drawer.cashCents)} de la caja. El contador vuelve a cero
          y empieza un periodo nuevo.
          {drawer.cardCents > 0 && (
            <>
              {' '}Los {formatMoney(drawer.cardCents)} de la terminal no están en la
              caja: ésos los deposita la terminal por su cuenta.
            </>
          )}
        </p>

        <label className="corte-field">
          <span>¿Quién entrega la caja?</span>
          <input
            className="text-input"
            value={cashier}
            onChange={(e) => setCashier(e.target.value)}
            placeholder="Nombre del cajero"
            maxLength={60}
            autoFocus
          />
        </label>

        <label className="checkbox-field">
          <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} />
          <span>Imprimir comprobante del corte</span>
        </label>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel} disabled={working}>Cancelar</button>
          <button className="btn-cobrar" onClick={confirm} disabled={working || !named}>
            {working ? 'GUARDANDO…' : 'CONFIRMAR CORTE'}
          </button>
        </div>
      </div>
    </div>
  )
}
