import { useMemo, useRef, useState } from 'react'
import type { CartLine, Product } from '../types'
import { formatMoney, parseAmount } from '../lib/money'
import { formatKg, kgForAmount, parseWeight, weightTotalCents } from '../lib/weight'

interface Props {
  product: Product
  onAdd: (line: CartLine) => void
  onCancel: () => void
}

/** Half a kilo and a quarter are most of what gets asked for by name. */
const SHORTCUTS = [0.25, 0.5, 1, 2]

/**
 * Weighing a product into the ticket.
 *
 * Two ways in, because the counter has two conversations and they are not the
 * same one:
 *
 *   POR PESO      "kilo y medio de frijol". The cashier reads the scale and
 *                 types it; the price follows from the weight.
 *   POR IMPORTE   "me da $50 de jamón". The customer named the money, so the
 *                 money is exact and the weight is what gets solved for — and
 *                 the slicer gets told how much to cut instead of the customer
 *                 being handed $49.60 worth and a shrug.
 *
 * Whichever way it was entered, the line stores both numbers: what was weighed
 * and what it cost. The receipt needs the weight, the corte needs the money,
 * and neither should have to re-derive the other and risk a different rounding.
 */
export function WeightModal({ product, onAdd, onCancel }: Props) {
  const [mode, setMode] = useState<'kg' | 'amount'>('kg')
  const [raw, setRaw] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const perKg = product.price_cents

  /**
   * What this entry resolves to, or null while it is still nonsense.
   *
   * Computed for both modes the same way round — weigh, then price — except
   * that entering by importe pins the total to the peso figure the customer
   * actually asked for rather than to the re-multiplied weight, which would
   * come back a few centavos off almost every time.
   */
  const resolved = useMemo(() => {
    if (mode === 'kg') {
      const kg = parseWeight(raw)
      if (kg === null) return null
      return { kg, totalCents: weightTotalCents(perKg, kg) }
    }
    const amount = parseAmount(raw)
    if (amount === null || amount <= 0) return null
    const kg = kgForAmount(perKg, amount)
    if (kg === null) return null
    return { kg, totalCents: amount }
  }, [mode, raw, perKg])

  function add(kg: number, totalCents: number) {
    onAdd({
      productId: product.id,
      name: product.name,
      unitPriceCents: perKg,
      qty: kg,
      unit: 'kg',
      lineTotalCents: totalCents,
    })
  }

  function confirm() {
    if (!resolved) return
    add(resolved.kg, resolved.totalCents)
  }

  function switchMode(next: 'kg' | 'amount') {
    setMode(next)
    // The digits do not carry over: "1.5" means a kilo and a half in one mode
    // and a peso fifty in the other, and silently reinterpreting them is how a
    // customer gets charged for 38 kilos of ham.
    setRaw('')
    inputRef.current?.focus()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal weight-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{product.name}</h2>
        <p className="weight-price">{formatMoney(perKg)} por kilo</p>

        <div className="weight-tabs">
          <button
            className={`weight-tab${mode === 'kg' ? ' is-active' : ''}`}
            onClick={() => switchMode('kg')}
          >
            POR PESO
          </button>
          <button
            className={`weight-tab${mode === 'amount' ? ' is-active' : ''}`}
            onClick={() => switchMode('amount')}
          >
            POR IMPORTE
          </button>
        </div>

        <label className="field">
          <span>{mode === 'kg' ? 'KILOS EN LA BÁSCULA' : 'CUÁNTO QUIERE ($)'}</span>
          <input
            ref={inputRef}
            className="text-input weight-input"
            inputMode="decimal"
            placeholder={mode === 'kg' ? '0.000' : '0.00'}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
            autoFocus
          />
        </label>

        {/* Only for weights: the equivalent shortcut for money would be a row of
            round pesos, which is exactly what the keypad is already for. */}
        {mode === 'kg' && (
          <div className="weight-shortcuts">
            {SHORTCUTS.map((kg) => (
              <button
                key={kg}
                className="weight-chip"
                onClick={() => add(kg, weightTotalCents(perKg, kg))}
              >
                <strong>{kg === 0.25 ? '¼' : kg === 0.5 ? '½' : kg} kg</strong>
                <em>{formatMoney(weightTotalCents(perKg, kg))}</em>
              </button>
            ))}
          </div>
        )}

        {/* The number the customer is about to be charged, at the size the
            cashier can read it from where they stand. It shows both sides of
            the conversion whichever way it was entered, so a fat-fingered
            decimal reads as "$390.00" long before it reaches the total. */}
        <div className="weight-result">
          {resolved ? (
            <>
              <span className="weight-result-qty">{formatKg(resolved.kg)}</span>
              <strong className="weight-result-total">{formatMoney(resolved.totalCents)}</strong>
            </>
          ) : (
            <span className="weight-result-empty">
              {mode === 'kg' ? 'Escribe el peso' : 'Escribe el importe'}
            </span>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancelar</button>
          <button className="btn-cobrar" onClick={confirm} disabled={!resolved}>
            AGREGAR
          </button>
        </div>
      </div>
    </div>
  )
}
