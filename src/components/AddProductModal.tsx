import { useEffect, useRef, useState } from 'react'
import type { NewProductInput } from '../types'
import { parseAmount } from '../lib/money'
import { pos } from '../lib/api'

interface Props {
  onSave: (input: NewProductInput) => Promise<void>
  onCancel: () => void
}

export function AddProductModal({ onSave, onCancel }: Props) {
  const [barcode, setBarcode] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('0')
  const [trackStock, setTrackStock] = useState(true)
  const [imageFile, setImageFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const barcodeRef = useRef<HTMLInputElement>(null)

  // Barcode field takes focus on open, so the first thing the scanner types
  // lands in the right box. The scanner's trailing Enter jumps to the name.
  useEffect(() => { barcodeRef.current?.focus() }, [])

  async function pickImage() {
    const file = await pos.pickImage()
    if (file) setImageFile(file)
  }

  async function save() {
    const priceCents = parseAmount(price)
    if (!name.trim()) return setError('Falta el nombre del producto')
    if (priceCents === null || priceCents <= 0) return setError('Precio inválido')

    setSaving(true)
    try {
      await onSave({
        barcode: barcode.trim() || null,
        name: name.trim(),
        priceCents,
        imageFile,
        // Blank means "I'll count it later", not "zero on the shelf" — but the
        // two are indistinguishable in an integer column, so blank becomes 0
        // and the inventory screen is where the real count gets entered.
        stock: Math.trunc(Number(stock) || 0),
        trackStock,
      })
    } catch (err) {
      // The most likely failure is the UNIQUE constraint on barcode.
      setError(
        String(err).includes('UNIQUE')
          ? 'Ese código de barras ya existe'
          : 'No se pudo guardar el producto'
      )
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal product-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Nuevo producto</h2>

        <label className="field">
          <span>CÓDIGO DE BARRAS</span>
          <input
            ref={barcodeRef}
            className="text-input"
            placeholder="Escanea el producto"
            value={barcode}
            onChange={(e) => { setBarcode(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              // The scanner ends its burst with Enter; move on to the name field.
              if (e.key === 'Enter') {
                e.preventDefault()
                document.getElementById('p-name')?.focus()
              }
            }}
          />
        </label>

        <label className="field">
          <span>NOMBRE</span>
          <input
            id="p-name"
            className="text-input"
            placeholder="Ej. Papas"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>PRECIO</span>
            <input
              className="text-input"
              placeholder="0.00"
              inputMode="decimal"
              value={price}
              onChange={(e) => { setPrice(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            />
          </label>

          <label className="field">
            <span>CANTIDAD</span>
            <input
              className="text-input"
              type="number"
              step="1"
              min="0"
              value={trackStock ? stock : ''}
              disabled={!trackStock}
              placeholder={trackStock ? undefined : 'granel'}
              onChange={(e) => { setStock(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            />
          </label>
        </div>

        {/* Off for anything sold by weight or by the bag: without this it would
            sit at zero forever and report AGOTADO on every single scan. */}
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={trackStock}
            onChange={(e) => setTrackStock(e.target.checked)}
          />
          <span>Llevar inventario de este producto</span>
        </label>

        <div className="field">
          <span>IMAGEN</span>
          <div className="image-picker">
            <div className="image-preview">
              {imageFile
                ? <img src={`posimg://images/${imageFile}`} alt="" />
                : <span className="thumb-placeholder">Sin imagen</span>}
            </div>
            <button className="btn-secondary" onClick={pickImage}>Elegir imagen…</button>
          </div>
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancelar</button>
          <button className="btn-cobrar" onClick={save} disabled={saving}>GUARDAR</button>
        </div>
      </div>
    </div>
  )
}
