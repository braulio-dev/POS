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

  async function confirm() {
    setWorking(true)
    // The cut commits to SQLite inside the main process before anything is
    // spooled, so an out-of-paper printer costs a slip, never the record.
    const { corte, printed } = await pos.recordCorte({ print })
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
          <div className="corte-summary-total">
            <dt>EFECTIVO</dt>
            <dd>{formatMoney(drawer.totalCents)}</dd>
          </div>
        </dl>

        <p className="muted-note">
          Saca {formatMoney(drawer.totalCents)} de la caja. El contador vuelve a cero
          y empieza un periodo nuevo.
        </p>

        <label className="checkbox-field">
          <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} />
          <span>Imprimir comprobante del corte</span>
        </label>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel} disabled={working}>Cancelar</button>
          <button className="btn-cobrar" onClick={confirm} disabled={working}>
            {working ? 'GUARDANDO…' : 'CONFIRMAR CORTE'}
          </button>
        </div>
      </div>
    </div>
  )
}
