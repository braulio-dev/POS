import { useEffect, useRef, useState } from 'react'
import { validateTender } from '../lib/tender'

interface Props {
  totalCents: number
  onConfirm: (receivedCents: number, changeCents: number) => void
  onCancel: () => void
}

export function PaymentModal({ totalCents, onConfirm, onCancel }: Props) {
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The cashier's hands are on the keyboard, not the mouse. Focus immediately
  // so they can type the cash and hit Enter without looking up.
  useEffect(() => { inputRef.current?.focus() }, [])

  function submit() {
    const result = validateTender(totalCents, raw)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onConfirm(result.receivedCents, result.changeCents)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal payment-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="payment-row">
          <label className="payment-label" htmlFor="recibido">RECIBIDO</label>
          <input
            id="recibido"
            ref={inputRef}
            className="text-input payment-input"
            placeholder="CANTIDAD"
            inputMode="decimal"
            value={raw}
            onChange={(e) => { setRaw(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </div>

        {error && <p className="field-error">{error}</p>}

        <button className="btn-cobrar payment-cobrar" onClick={submit}>COBRAR</button>
      </div>
    </div>
  )
}
