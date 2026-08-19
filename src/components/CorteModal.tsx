import { useState } from 'react'
import { formatMoney, parseAmount } from '../lib/money'
import type { CashDrawer, Corte } from '../types'
import { pos } from '../lib/api'

interface Props {
  drawer: CashDrawer
  /** Default fondo to leave behind, from Configuración → Corte. */
  suggestedFloatCents: number
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

export function CorteModal({ drawer, suggestedFloatCents, onDone, onCancel }: Props) {
  const [working, setWorking] = useState(false)
  const [print, setPrint] = useState(true)
  const [cashier, setCashier] = useState('')
  const [counted, setCounted] = useState('')
  const [floatLeft, setFloatLeft] = useState(
    suggestedFloatCents > 0 ? (suggestedFloatCents / 100).toFixed(2) : ''
  )

  // Who was on the till is the one thing about a corte nobody can reconstruct
  // afterwards: the amount and the period are in the database, the name only
  // ever exists in the room. So the cut will not go through without it.
  const named = cashier.trim().length > 0

  const countedCents = parseAmount(counted)
  const floatLeftCents = parseAmount(floatLeft) ?? 0

  // Same reasoning as the name, and stronger. Every other figure on this screen
  // can be rebuilt from the sales table years from now; what was physically in
  // the drawer exists for about ten seconds on a counter and then is gone. If
  // it is not typed here it is never knowable, so the cut asks for it.
  const countedOk = countedCents !== null && countedCents >= 0

  const differenceCents = countedOk ? countedCents - drawer.expectedCents : null
  const inDrawer = countedOk ? countedCents : drawer.expectedCents
  const deliveredCents = Math.max(0, inDrawer - Math.min(floatLeftCents, inDrawer))

  async function confirm() {
    if (!named || !countedOk) return
    setWorking(true)
    // The cut commits to SQLite inside the main process before anything is
    // spooled, so an out-of-paper printer costs a slip, never the record.
    const { corte, printed } = await pos.recordCorte({
      print,
      cashier: cashier.trim(),
      countedCents,
      floatLeftCents,
    })
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

          {/* The same rule for the drawer's own movements: a fondo of zero and
              no entradas is the common case, and printing three zeroes teaches
              the eye to skip the block that carries the fondo when there is
              one. */}
          {drawer.floatCents > 0 && (
            <div>
              <dt>FONDO INICIAL</dt>
              <dd>{formatMoney(drawer.floatCents)}</dd>
            </div>
          )}
          <div>
            <dt>EFECTIVO VENTAS</dt>
            <dd>{formatMoney(drawer.cashCents)}</dd>
          </div>
          {drawer.cashInCents > 0 && (
            <div>
              <dt>ENTRADAS</dt>
              <dd>{formatMoney(drawer.cashInCents)}</dd>
            </div>
          )}
          {drawer.cashOutCents > 0 && (
            <div>
              <dt>SALIDAS</dt>
              <dd>−{formatMoney(drawer.cashOutCents)}</dd>
            </div>
          )}

          <div className="corte-summary-total">
            <dt>DEBE HABER</dt>
            <dd>{formatMoney(drawer.expectedCents)}</dd>
          </div>
        </dl>

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

        <div className="field-row">
          <label className="field">
            {/* Counted first and on its own, before the screen shows whether it
                matches. Prefilling it with the expected figure — or showing the
                difference as it is typed — would turn a count into a
                confirmation, and a cashier who is short will simply type what
                the screen already said. */}
            <span>¿CUÁNTO HAY CONTADO?</span>
            <input
              className="text-input"
              inputMode="decimal"
              placeholder="0.00"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
          </label>
          <label className="field">
            <span>SE QUEDA DE FONDO</span>
            <input
              className="text-input"
              inputMode="decimal"
              placeholder="0.00"
              value={floatLeft}
              onChange={(e) => setFloatLeft(e.target.value)}
            />
          </label>
        </div>

        {/*
          The verdict, once there is something to compare. A difference does not
          block the cut: the money is already however much it is, and refusing
          to close would leave the drawer open, the period unclosed and the
          discrepancy unwritten — strictly worse than recording it. What it does
          is say so plainly, in the words the owner will use when they ask.
        */}
        {countedOk && differenceCents !== null && (
          <div className={`corte-verdict${differenceCents === 0 ? ' is-ok' : differenceCents < 0 ? ' is-short' : ' is-over'}`}>
            <span>
              {differenceCents === 0
                ? 'La caja cuadra'
                : differenceCents < 0
                  ? `Faltan ${formatMoney(-differenceCents)}`
                  : `Sobran ${formatMoney(differenceCents)}`}
            </span>
            <strong>Entrega {formatMoney(deliveredCents)}</strong>
          </div>
        )}

        <p className="muted-note">
          Saca {formatMoney(deliveredCents)} de la caja
          {floatLeftCents > 0 && ` y deja ${formatMoney(Math.min(floatLeftCents, inDrawer))} de fondo`}.
          El contador vuelve a cero y empieza un periodo nuevo.
          {drawer.cardCents > 0 && (
            <>
              {' '}Los {formatMoney(drawer.cardCents)} de la terminal no están en la
              caja: ésos los deposita la terminal por su cuenta.
            </>
          )}
        </p>

        <label className="checkbox-field">
          <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} />
          <span>Imprimir comprobante del corte</span>
        </label>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel} disabled={working}>Cancelar</button>
          <button className="btn-cobrar" onClick={confirm} disabled={working || !named || !countedOk}>
            {working ? 'GUARDANDO…' : 'CONFIRMAR CORTE'}
          </button>
        </div>
      </div>
    </div>
  )
}
