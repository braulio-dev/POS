/**
 * Dev utility: proves that a `product-purge` arriving from the server removes
 * the product locally without destroying the receipt history that points at it.
 *
 *   npx electron scripts/test-purge.cjs
 *
 * The register enforces foreign keys (PRAGMA foreign_keys = ON) and sale_items
 * references products(id), so the purge has to detach the line items before it
 * deletes the row. This checks that it does, and that a reprinted receipt would
 * still show the name and price the customer actually paid.
 */
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const db = require('../electron/db.cjs')

const DATA = path.join(app.getPath('temp'), 'pos-purge-test')

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

app.whenReady().then(() => {
  fs.rmSync(DATA, { recursive: true, force: true })
  db.openDatabase(DATA)

  // A product, and a sale that used it.
  db.applyRemoteChange({
    entity: 'product',
    payload: {
      uuid: 'zap-1', name: 'Jabon viejo', priceCents: 1500,
      trackStock: 1, updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  const product = db.listProducts().find((p) => p.name === 'Jabon viejo')
  check('product landed on the register', Boolean(product))

  const sale = db.recordSale({
    items: [{ productId: product.id, name: 'Jabon viejo', unitPriceCents: 1500, qty: 2 }],
    totalCents: 3000, receivedCents: 5000, changeCents: 2000,
    paymentMethod: 'cash', cashCents: 3000, cardCents: 0,
  })
  check('sale recorded', Boolean(sale && sale.uuid))

  // The purge itself.
  const result = db.applyRemoteChange({ entity: 'product-purge', payload: { uuid: 'zap-1' } })
  check('purge applied', result.applied === true)
  check('product gone from the catalogue', !db.listProducts().some((p) => p.name === 'Jabon viejo'))

  // An unknown uuid must be a no-op rather than an error.
  const missing = db.applyRemoteChange({ entity: 'product-purge', payload: { uuid: 'never-existed' } })
  check('purge of an unknown product is a no-op', missing.applied === false)

  // What a reprinted receipt reads from.
  const { DatabaseSync } = require('node:sqlite')
  const raw = new DatabaseSync(path.join(DATA, 'pos.db'))
  const items = raw.prepare('SELECT name, unit_price_cents, qty, product_id FROM sale_items').all()

  check('line items survived', items.length === 1, JSON.stringify(items))
  check('line item keeps the name and price it was sold at',
    Boolean(items[0]) && items[0].name === 'Jabon viejo' && items[0].unit_price_cents === 1500)
  check('line item detached from the deleted product',
    Boolean(items[0]) && items[0].product_id === null)

  const dangling = raw.prepare('PRAGMA foreign_key_check').all()
  check('no dangling foreign keys', dangling.length === 0, JSON.stringify(dangling))
  raw.close()

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  app.exit(failures === 0 ? 0 : 1)
})
