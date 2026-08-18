import type { Product } from '../types'

export type StockVerdict =
  | { allow: true; warning?: string }
  | { allow: false; error: string }

export type StockLevel = 'untracked' | 'over' | 'out' | 'low' | 'ok'

/**
 * What happens when the cashier adds a product whose recorded stock cannot
 * cover it.
 *
 * The four open questions are now settled, and the answers are all versions of
 * the same principle: **the count serves the shop, the shop does not serve the
 * count.**
 *
 *   1. Overselling never blocks. The customer is standing at the counter with
 *      the item in their hand — that is ground truth, and a miscounted shelf
 *      does not get to veto a sale that is physically happening. `allow` is
 *      unconditionally true below, and the union type keeps the door open if
 *      that ever needs to change for a specific product.
 *
 *   2. Stock is allowed to go negative rather than clamping at zero. "-3" means
 *      three more were sold than the books thought, which is precisely the
 *      signal telling the owner which shelf to recount. Clamping would throw
 *      that information away and quietly make the books look correct.
 *
 *   3. Products sold loose — frijol por kilo, bolsas — carry `track_stock = 0`.
 *      Without that flag they would sit at zero forever, report AGOTADO on
 *      every scan, and train the cashier to ignore the warnings that matter.
 *
 *   4. Only actionable news reaches the cashier. "Quedan 2" is worth a toast:
 *      they can tell the owner to reorder. "Sin existencia" is not — they
 *      cannot conjure stock mid-transaction, and it would fire on every scan of
 *      a popular item. Out-of-stock and negative stock are shown where the
 *      person who can act on them looks: the badge on the card and the
 *      Inventario screen.
 *
 * @param product     the product being added
 * @param qtyInCart   how many of it are already in the cart
 * @param lowStockAt  the "running out" mark from Configuración
 */
export function checkStock(product: Product, qtyInCart: number, lowStockAt: number): StockVerdict {
  // Sold by weight or by the bag: there is no unit count to be low on.
  if (!product.track_stock) return { allow: true }

  const remaining = product.stock - qtyInCart

  // Below zero the shelf is already wrong; saying so at the till helps nobody.
  // The badge and the Inventario screen carry it to the owner instead.
  if (remaining <= 0) return { allow: true }

  // The one genuinely actionable case: still sellable, nearly gone, reorder it.
  if (remaining <= lowStockAt) {
    return { allow: true, warning: `${product.name}: quedan ${remaining}` }
  }

  return { allow: true }
}

/**
 * Visual band for the badge on a product card and the inventory rows.
 * `over` is the recount flag — more sold than the books ever had.
 */
export function stockLevel(product: Product, lowStockAt: number): StockLevel {
  if (!product.track_stock) return 'untracked'
  if (product.stock < 0) return 'over'
  if (product.stock === 0) return 'out'
  if (product.stock <= lowStockAt) return 'low'
  return 'ok'
}

/** Short label for a badge, or null when the count is unremarkable. */
export function stockLabel(level: StockLevel, stock: number): string | null {
  switch (level) {
    case 'over': return String(stock)
    case 'out': return 'AGOTADO'
    case 'low': return String(stock)
    default: return null
  }
}
