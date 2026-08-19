import { useEffect, useMemo, useState } from 'react'
import type { NewProductInput, Product } from '../types'
import { formatMoney } from '../lib/money'
import { stockLevel } from '../lib/stock'
import { pos } from '../lib/api'
import { AddProductModal } from './AddProductModal'

interface Props {
  lowStockAt: number
  onClose: (changed: boolean) => void
}

/**
 * Physical-count screen: every product, one editable quantity each.
 *
 * Edits are held locally and written in a single bulk transaction on GUARDAR,
 * rather than saved per keystroke. Counting a shelf means typing over numbers
 * repeatedly, and a per-keystroke save would push a sync message for every
 * intermediate value — including the empty string between deleting "12" and
 * typing "15".
 */
export function InventoryModal({ lowStockAt, onClose }: Props) {
  const [products, setProducts] = useState<Product[] | null>(null)
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => { pos.listInventory().then(setProducts) }, [])

  const visible = useMemo(() => {
    if (!products) return []
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.barcode ?? '').includes(q)
    )
  }, [products, search])

  // Only rows the user actually retyped are sent, so opening this screen and
  // closing it again never restamps every product's stock timestamp.
  const pending = useMemo(() => {
    if (!products) return []
    return products
      .filter((p) => {
        const typed = draft[p.id]
        return typed !== undefined && typed !== '' && Number(typed) !== p.stock
      })
      .map((p) => ({ id: p.id, stock: Number(draft[p.id]) }))
  }, [products, draft])

  function setValue(id: number, value: string) {
    setDraft((prev) => ({ ...prev, [id]: value }))
    setStatus(null)
  }

  function bump(product: Product, delta: number) {
    const current = draft[product.id] !== undefined && draft[product.id] !== ''
      ? Number(draft[product.id])
      : product.stock
    setValue(product.id, String(current + delta))
  }

  /**
   * Creating a product lives here rather than on the sale screen: it sets a
   * price, and a price is an owner decision. Everything behind this modal is
   * already past the password prompt.
   *
   * Errors are deliberately left to propagate — AddProductModal catches them and
   * shows "ese código de barras ya existe" against the right field.
   */
  async function saveProduct(input: NewProductInput) {
    const created = await pos.createProduct(input)
    setProducts(await pos.listInventory())
    setAdding(false)
    setStatus(`${created.name} agregado`)
  }

  async function save() {
    if (pending.length === 0) return onClose(false)
    setSaving(true)
    const updated = await pos.setStockBulk(pending)
    setProducts(updated)
    setDraft({})
    setSaving(false)
    setStatus(`${pending.length} ${pending.length === 1 ? 'producto' : 'productos'} actualizados`)
  }

  return (
    // A fragment, not a wrapper: AddProductModal must be a sibling of this
    // backdrop rather than a child of it. Nested inside, a mousedown on the add
    // dialog's own backdrop would bubble up to this one and close Inventario
    // out from under it.
    <>
    <div className="modal-backdrop" onMouseDown={() => onClose(pending.length === 0 ? false : true)}>
      <div className="modal inventory-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Inventario</h2>

        <div className="inventory-toolbar">
          <input
            className="text-input"
            placeholder="Buscar producto"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn-secondary inventory-add" onClick={() => setAdding(true)}>
            + NUEVO PRODUCTO
          </button>
        </div>

        <div className="inventory-scroll">
          {products === null ? (
            <p className="muted-note">Cargando…</p>
          ) : visible.length === 0 ? (
            <p className="muted-note">Sin productos que coincidan.</p>
          ) : (
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="num">Precio</th>
                  <th
                    className="tracked-col"
                    title="Por pieza: se cuenta y el precio es de cada una. Por kilo: se pesa en la báscula y no se lleva conteo."
                  >
                    Se vende
                  </th>
                  <th className="num">Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const value = draft[p.id] !== undefined ? draft[p.id] : String(p.stock)
                  const level = stockLevel({ ...p, stock: Number(value) || 0 }, lowStockAt)
                  const tracked = Boolean(p.track_stock)
                  return (
                    <tr key={p.id} className={draft[p.id] !== undefined ? 'row-dirty' : undefined}>
                      <td className="inventory-name" title={p.name}>
                        {p.name}
                        {/* Negative stock is the recount flag: more went out the
                            door than the books ever had in. */}
                        {level === 'over' && <span className="recount-flag">recontar</span>}
                      </td>
                      {/* A product sold por kilo prices a kilo, so the column
                          has to say which it is — the same number means two
                          different things depending on the cell beside it. */}
                      <td className="num">
                        {formatMoney(p.price_cents)}
                        {!tracked && <span className="muted-note"> /kg</span>}
                      </td>
                      <td className="tracked-col">
                        {/* Both states visible at once, and both named. A lone
                            checkbox could only ever say what the ticked state
                            meant, which left "por kilo" as something you had to
                            infer from a greyed-out quantity box. */}
                        <div className="sale-unit-toggle is-compact">
                          <button
                            className={`sale-unit-option${tracked ? ' is-active' : ''}`}
                            aria-pressed={tracked}
                            onClick={async () => {
                              if (tracked) return
                              await pos.setTrackStock(p.id, true)
                              setProducts(await pos.listInventory())
                            }}
                          >
                            Pieza
                          </button>
                          <button
                            className={`sale-unit-option${!tracked ? ' is-active' : ''}`}
                            aria-pressed={!tracked}
                            onClick={async () => {
                              if (!tracked) return
                              await pos.setTrackStock(p.id, false)
                              setProducts(await pos.listInventory())
                            }}
                          >
                            Kilo
                          </button>
                        </div>
                      </td>
                      <td className="num">
                        <div className="qty-editor">
                          <button className="qty-btn" onClick={() => bump(p, -1)} disabled={!tracked} aria-label="Quitar uno">−</button>
                          <input
                            className={`text-input qty-input stock-${level}`}
                            type="number"
                            step="1"
                            value={tracked ? value : ''}
                            placeholder={tracked ? undefined : 'se pesa'}
                            disabled={!tracked}
                            onChange={(e) => setValue(p.id, e.target.value)}
                          />
                          <button className="qty-btn" onClick={() => bump(p, 1)} disabled={!tracked} aria-label="Agregar uno">+</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="muted-note">
          <strong>Por pieza</strong>: se cuenta, y el precio es el de una pieza.
          <br />
          <strong>Por kilo</strong> para lo que se pesa — frijol, queso, jamón:
          el precio pasa a ser por kilo, la caja pide el peso al venderlo, y deja
          de contarse (si no, saldría siempre como AGOTADO y acabaríamos
          ignorando los avisos que sí importan).
        </p>

        {status && <p className="settings-status">{status}</p>}

        <div className="modal-actions">
          <span className="inventory-pending muted-note">
            {pending.length > 0
              ? `${pending.length} sin guardar`
              : 'Sin cambios'}
          </span>
          <button className="btn-secondary" onClick={() => onClose(false)} disabled={saving}>Cerrar</button>
          <button className="btn-cobrar" onClick={save} disabled={saving || pending.length === 0}>
            {saving ? 'GUARDANDO…' : 'GUARDAR'}
          </button>
        </div>
      </div>
    </div>

    {adding && (
      <AddProductModal onSave={saveProduct} onCancel={() => setAdding(false)} />
    )}
    </>
  )
}
