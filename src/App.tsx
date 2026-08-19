import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CartLine, CashDrawer, Product, Settings } from './types'
import { useBarcodeScanner } from './hooks/useBarcodeScanner'
import { Header } from './components/Header'
import { ProductGrid } from './components/ProductGrid'
import { Cart } from './components/Cart'
import { PaymentModal } from './components/PaymentModal'
import { ChangeScreen } from './components/ChangeScreen'
import { SettingsModal } from './components/SettingsModal'
import { InventoryModal } from './components/InventoryModal'
import { PasswordPrompt } from './components/PasswordPrompt'
import { CorteBanner } from './components/CorteBanner'
import { CorteModal } from './components/CorteModal'
import { checkStock } from './lib/stock'
import type { Tender } from './lib/tender'
import { pos } from './lib/api'

/** Screens that need the password before they will open. */
type Protected = 'settings' | 'inventory'

type Overlay =
  | { kind: 'none' }
  | { kind: 'password'; then: Protected }
  | { kind: 'settings' }
  | { kind: 'inventory' }
  | { kind: 'corte' }
  | { kind: 'payment' }
  | { kind: 'change'; totalCents: number; tender: Tender }

export default function App() {
  const [products, setProducts] = useState<Product[]>([])
  const [lines, setLines] = useState<CartLine[]>([])
  const [search, setSearch] = useState('')
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })
  const [toast, setToast] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [drawer, setDrawer] = useState<CashDrawer | null>(null)

  const refreshProducts = useCallback(() => pos.listProducts().then(setProducts), [])
  const refreshDrawer = useCallback(() => pos.getCashDrawer().then(setDrawer), [])

  useEffect(() => {
    refreshProducts()
    refreshDrawer()
    pos.getSettings().then(setSettings)
  }, [refreshProducts, refreshDrawer])

  // Sync can change prices and stock underneath the cashier while the register
  // is idle, so the grid follows the worker rather than only reloading on open.
  useEffect(() => pos.onSyncStatus((status) => {
    if (!status.running) refreshProducts()
  }), [refreshProducts])

  const lowStockAt = Number(settings?.lowStockThreshold ?? 3) || 0

  const totalCents = useMemo(
    () => lines.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0),
    [lines]
  )

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2200)
  }, [])

  /**
   * Adding the same product twice bumps the quantity rather than appending a
   * second row — a cart of "COCA ×6" reads far faster at the counter than six
   * identical lines the cashier has to count.
   */
  const addToCart = useCallback((product: Product) => {
    // The stock rule lives in lib/stock.ts, not here: whether a thin shelf warns
    // or blocks is store policy, and policy belongs somewhere it can be read and
    // changed without picking through cart state.
    //
    // It is checked out here rather than inside the updater below because React
    // may run an updater more than once (it does, under StrictMode) and an
    // updater that raises a toast would fire it twice.
    const alreadyInCart = lines.find((l) => l.productId === product.id)?.qty ?? 0
    const verdict = checkStock(product, alreadyInCart, lowStockAt)
    if (!verdict.allow) {
      showToast(verdict.error)
      return
    }
    if (verdict.warning) showToast(verdict.warning)

    setLines((prev) => {
      const i = prev.findIndex((l) => l.productId === product.id)
      if (i === -1) {
        return [...prev, {
          productId: product.id,
          name: product.name,
          unitPriceCents: product.price_cents,
          qty: 1,
        }]
      }
      const next = [...prev]
      next[i] = { ...next[i], qty: next[i].qty + 1 }
      return next
    })
  }, [lines, lowStockAt, showToast])

  // Tapping a cart row removes one unit; the last unit removes the row.
  const removeOne = useCallback((index: number) => {
    setLines((prev) =>
      prev.flatMap((l, i) => (i !== index ? [l] : l.qty > 1 ? [{ ...l, qty: l.qty - 1 }] : []))
    )
  }, [])

  const handleScan = useCallback(async (code: string) => {
    const product = await pos.findByBarcode(code)
    if (product) {
      addToCart(product)
    } else {
      // An unknown barcode is normal: new stock arrives before it's registered.
      showToast(`Código no registrado: ${code}`)
    }
  }, [addToCart, showToast])

  // The global scanner listener only runs on the sale screen. While a modal is
  // open the scanner should type into that modal's focused field instead.
  useBarcodeScanner(handleScan, overlay.kind === 'none')

  /**
   * Closes a sale.
   *
   * By the time this runs the tender has already been validated — including,
   * on a card sale, that the terminal actually approved it and gave back an
   * authorisation number. See src/lib/tender.ts for why that is a hard gate:
   * money the register cannot prove arrived must never reach the books.
   */
  async function completeSale(tender: Tender) {
    const snapshot = {
      totalCents,
      receivedCents: tender.receivedCents,
      changeCents: tender.changeCents,
      paymentMethod: tender.method,
      cashCents: tender.cashCents,
      cardCents: tender.cardCents,
      terminal: tender.terminal,
    }
    const items = lines

    // The sale is committed to SQLite first and the change screen goes up
    // immediately. Printing happens after, un-awaited, because a jammed or
    // unplugged printer must never hold up the counter or lose a recorded sale.
    //
    // TODO(you): the cash drawer opens off the back of this call, and only this
    // call — see the full note at the `sales:record` handler in electron/ipc.cjs.
    // It belongs in the main process rather than here: the servo is on a serial
    // port, the renderer has no business touching one, and firing it from here
    // would mean a sale that failed to commit could still pop the drawer.
    // Two conditions, both load-bearing: after the insert has succeeded, and
    // only when `tender.cashCents > 0` — a pure card sale has no change to give.
    const sale = await pos.recordSale({ items, ...snapshot })
    setLines([])
    setOverlay({ kind: 'change', totalCents, tender })

    // Stock moved and the drawer grew; both are read back from SQLite rather
    // than guessed at here, so the badge and the corte banner agree with what
    // was actually committed.
    refreshProducts()
    refreshDrawer()

    if (settings?.autoPrint === '1') {
      pos
        .printReceipt({ items, ...snapshot, folio: sale.uuid, createdAt: sale.createdAt })
        .then((result) => {
          if (!result.ok) showToast('No se imprimió el ticket')
        })
        .catch(() => showToast('No se imprimió el ticket'))
    }
  }

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.barcode ?? '').includes(q)
    )
  }, [products, search])

  if (overlay.kind === 'change') {
    return (
      <ChangeScreen
        totalCents={overlay.totalCents}
        tender={overlay.tender}
        onDismiss={() => setOverlay({ kind: 'none' })}
      />
    )
  }

  return (
    <div className="app">
      <Header
        storeName={settings?.storeName ?? ''}
        onOpenSettings={() => setOverlay({ kind: 'password', then: 'settings' })}
        onOpenInventory={() => setOverlay({ kind: 'password', then: 'inventory' })}
      />

      <main className="body">
        {/* The grid scrolls; the search strip beneath it does not. Search sits
            under the shelf it filters rather than in a footer across the whole
            window, so the eye travels from the box to the results and stops. */}
        <section className="grid-pane">
          <ProductGrid
            products={visibleProducts}
            lowStockAt={lowStockAt}
            onSelect={addToCart}
          />
          <div className="search-strip">
            <input
              className="text-input search-input"
              placeholder="Buscar producto o código"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="strip-note">
              {visibleProducts.length}{' '}
              {visibleProducts.length === 1 ? 'producto' : 'productos'}
            </span>
          </div>
        </section>

        <Cart
          lines={lines}
          totalCents={totalCents}
          onRemove={removeOne}
          onCorte={() => setOverlay({ kind: 'corte' })}
          onCobrar={() => setOverlay({ kind: 'payment' })}
        />
      </main>

      {/* Sits in the layout rather than floating over it, so it physically
          pushes the till up and cannot be worked past without noticing. */}
      {drawer?.needsCorte && overlay.kind === 'none' && (
        <CorteBanner drawer={drawer} onCorte={() => setOverlay({ kind: 'corte' })} />
      )}

      {overlay.kind === 'password' && (
        <PasswordPrompt
          onUnlock={() => setOverlay({ kind: overlay.then })}
          onCancel={() => setOverlay({ kind: 'none' })}
        />
      )}

      {overlay.kind === 'settings' && (
        <SettingsModal
          // Applied as it is typed, which is what keeps the header title and the
          // corte threshold in step with the form instead of a reload behind it.
          onSettingsChange={(next) => {
            setSettings(next)
            refreshDrawer()
          }}
          onClose={() => {
            setOverlay({ kind: 'none' })
            pos.getSettings().then(setSettings)
            refreshDrawer()
          }}
        />
      )}

      {overlay.kind === 'inventory' && (
        <InventoryModal
          lowStockAt={lowStockAt}
          onClose={() => {
            setOverlay({ kind: 'none' })
            refreshProducts()
          }}
        />
      )}

      {overlay.kind === 'corte' && drawer && (
        <CorteModal
          drawer={drawer}
          onCancel={() => setOverlay({ kind: 'none' })}
          onDone={(corte, printed) => {
            setOverlay({ kind: 'none' })
            refreshDrawer()
            showToast(
              // The cash figure, not the sales total: this is the number the
              // cashier is about to count out of the drawer.
              printed.ok
                ? `Corte hecho: ${(corte.cashCents / 100).toFixed(2)} en efectivo`
                : 'Corte guardado (no se imprimió el comprobante)'
            )
          }}
        />
      )}

      {overlay.kind === 'payment' && (
        <PaymentModal
          totalCents={totalCents}
          terminalEnabled={settings?.terminalEnabled === '1'}
          onConfirm={completeSale}
          onCancel={() => setOverlay({ kind: 'none' })}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
