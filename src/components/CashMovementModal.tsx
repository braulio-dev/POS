import { useEffect, useState } from 'react'
import type { CashDrawer, CashMovement, MovementKind } from '../types'
import { formatMoney, parseAmount } from '../lib/money'
import { pos } from '../lib/api'

interface Props {
  drawer: CashDrawer
  onDone: () => void
  onClose: () => void
}

/** The reasons that actually happen, so most entries are two taps and a number. */
const REASONS: Record<MovementKind, string[]> = {
  in: ['Fondo de caja', 'Depósito del dueño', 'Cambio de la papelería'],
  out: ['Pago a proveedor', 'Retiro a la caja fuerte', 'Gasto de la tienda'],
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('es-MX', { timeStyle: 'short' })
}

/**
 * Cash going in or out of the drawer for a reason that is not a sale.
 *
 * This is the screen that makes the corte's difference figure mean something.
 * Paying the tortilla delivery out of the till is completely normal and happens
 * several times a week; with nowhere to record it, every one of those turns
 * into an unexplained faltante at closing time, and a cashier who is blamed for
 * four faltantes they can explain stops believing the fifth one matters.
 *
 * Not behind the owner's password, deliberately — see db.recordMovement. The
 * money leaves whether or not the owner is in the shop; the only thing a lock
 * would prevent is the record. What it does insist on is a reason.
 */
export function CashMovementModal({ drawer, onDone, onClose }: Props) {
  const [kind, setKind] = useState<MovementKind>('out')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [person, setPerson] = useState('')
  const [movements, setMovements] = useState<CashMovement[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { pos.listMovements().then(setMovements) }, [])

  const amountCents = parseAmount(amount)
  const ready = amountCents !== null && amountCents > 0 && reason.trim().length > 0

  async function save() {
    if (!ready || amountCents === null) return
    setSaving(true)
    try {
      await pos.recordMovement({
        kind,
        amountCents,
        reason: reason.trim(),
        person: person.trim() || null,
      })
      setMovements(await pos.listMovements())
      setAmount('')
      setReason('')
      setError(null)
      // The drawer figure at the top of this screen has just changed, and so
      // has the corte banner behind it, so the caller reloads both.
      onDone()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal cash-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Entradas y salidas</h2>

        {/* What the drawer should be holding right now, which is the number
            this screen exists to keep true. Sales alone would not answer it. */}
        <dl className="corte-summary">
          <div>
            <dt>FONDO</dt>
            <dd>{formatMoney(drawer.floatCents)}</dd>
          </div>
          <div>
            <dt>VENTAS EFECTIVO</dt>
            <dd>{formatMoney(drawer.cashCents)}</dd>
          </div>
          <div>
            <dt>ENTRADAS</dt>
            <dd>{formatMoney(drawer.cashInCents)}</dd>
          </div>
          <div>
            <dt>SALIDAS</dt>
            <dd>−{formatMoney(drawer.cashOutCents)}</dd>
          </div>
          <div className="corte-summary-total">
            <dt>DEBE HABER</dt>
            <dd>{formatMoney(drawer.expectedCents)}</dd>
          </div>
        </dl>

        <div className="movement-kind">
          <button
            className={`movement-tab${kind === 'out' ? ' is-active is-out' : ''}`}
            onClick={() => { setKind('out'); setReason(''); setError(null) }}
          >
            SALIDA
          </button>
          <button
            className={`movement-tab${kind === 'in' ? ' is-active is-in' : ''}`}
            onClick={() => { setKind('in'); setReason(''); setError(null) }}
          >
            ENTRADA
          </button>
        </div>

        <div className="field-row">
          <label className="field">
            <span>MONTO</span>
            <input
              className="text-input"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null) }}
              autoFocus
            />
          </label>
          <label className="field">
            <span>QUIÉN</span>
            <input
              className="text-input"
              placeholder="Opcional"
              maxLength={60}
              value={person}
              onChange={(e) => setPerson(e.target.value)}
            />
          </label>
        </div>

        <label className="field">
          <span>MOTIVO</span>
          <input
            className="text-input"
            placeholder={kind === 'out' ? 'Ej. Pago de tortillas' : 'Ej. Fondo de caja'}
            maxLength={80}
            value={reason}
            onChange={(e) => { setReason(e.target.value); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          />
        </label>

        {/* Typing a motivo every time is what makes people stop typing one at
            all, and a blank motivo is the same as no record. */}
        <div className="reason-chips">
          {REASONS[kind].map((r) => (
            <button key={r} className="reason-chip" onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="movement-list">
          {movements === null ? (
            <p className="muted-note">Cargando…</p>
          ) : movements.length === 0 ? (
            <p className="muted-note">Sin movimientos en este periodo.</p>
          ) : (
            movements.map((m) => (
              <div key={m.uuid} className={`movement-row movement-${m.kind}`}>
                <span className="movement-time">{shortTime(m.createdAt)}</span>
                <span className="movement-reason">
                  {m.reason}
                  {m.person && <em> · {m.person}</em>}
                </span>
                <span className="movement-amount">
                  {m.kind === 'out' ? '−' : '+'}{formatMoney(m.amountCents)}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cerrar</button>
          <button className="btn-cobrar" onClick={save} disabled={!ready || saving}>
            {saving ? 'GUARDANDO…' : kind === 'out' ? 'REGISTRAR SALIDA' : 'REGISTRAR ENTRADA'}
          </button>
        </div>
      </div>
    </div>
  )
}
