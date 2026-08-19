const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

let db

const now = () => new Date().toISOString()

// Sorts before every real timestamp. Used as the stock_updated_at of a product
// pulled from the server, whose quantity we do not know yet.
const NO_STOCK_YET = '1970-01-01T00:00:00.000Z'

/** Scrypt with a per-install random salt. Cheap to verify, painful to brute. */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex')
}

/**
 * Adds a column only if it isn't there yet. SQLite has no `ADD COLUMN IF NOT
 * EXISTS`, and a register already running in the store has a products table
 * full of real rows — dropping and recreating it is not an option.
 */
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

/**
 * Opens (and migrates) the local store database.
 * SQLite on local disk is the source of truth: a sale must be able to complete
 * with the internet down. Cloud sync drains the `outbox` table when it can.
 */
function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  db = new DatabaseSync(path.join(dataDir, 'pos.db'))

  // WAL lets the sync worker read while the register writes.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY,
      barcode     TEXT UNIQUE,
      name        TEXT    NOT NULL,
      price_cents INTEGER NOT NULL,
      image_file  TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id             INTEGER PRIMARY KEY,
      uuid           TEXT    NOT NULL UNIQUE,
      total_cents    INTEGER NOT NULL,
      received_cents INTEGER NOT NULL,
      change_cents   INTEGER NOT NULL,
      created_at     TEXT    NOT NULL
    );

    -- Line items snapshot the name and price. A receipt reprinted next year must
    -- show what the customer actually paid, not today's price.
    CREATE TABLE IF NOT EXISTS sale_items (
      id               INTEGER PRIMARY KEY,
      sale_id          INTEGER NOT NULL REFERENCES sales(id),
      product_id       INTEGER REFERENCES products(id),
      name             TEXT    NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      qty              INTEGER NOT NULL
    );

    -- Transactional outbox: written in the same transaction as the sale, drained
    -- later by the sync worker. Survives power cuts and dead internet.
    CREATE TABLE IF NOT EXISTS outbox (
      id          INTEGER PRIMARY KEY,
      entity      TEXT NOT NULL,
      entity_uuid TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      sent_at     TEXT
    );

    -- Cash cuts ("cortes"). Each row closes the period that began when the
    -- previous one was taken, so drawer totals are always a range query.
    CREATE TABLE IF NOT EXISTS cortes (
      id          INTEGER PRIMARY KEY,
      uuid        TEXT    NOT NULL UNIQUE,
      total_cents INTEGER NOT NULL,
      sale_count  INTEGER NOT NULL,
      -- Who handed the cash over. Typed at the register rather than taken from
      -- a login: the till has no user accounts, and the owner needs a name on
      -- the slip more than it needs an identity system.
      cashier     TEXT,
      opened_at   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL
    );

    -- Key/value settings. One row per setting keeps migrations trivial compared
    -- to a wide single-row table that needs ALTER for every new option.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Sync bookkeeping (server cursor, last run, last error). Deliberately not
    -- in the settings table: machine state, not something the owner configures.
    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_outbox_unsent ON outbox(sent_at) WHERE sent_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_cortes_created ON cortes(created_at);
  `)

  migrateProducts()
  migrateSales()
  // Tills that predate the manual corte have cortes rows with no cashier at
  // all; the column is nullable so those stay readable instead of inventing a
  // name nobody typed.
  addColumnIfMissing('cortes', 'cashier', 'TEXT')
  migrateCortes()
  seedDefaults()

  return db
}

/**
 * Products gained four columns once inventory and sync arrived:
 *
 *   uuid              a store-independent identity. The autoincrement `id` is
 *                     local: two machines will both hand out id 7 to different
 *                     products, so it can never be the sync key.
 *   stock             units on the shelf.
 *   updated_at        last edit to name/price/barcode/image.
 *   stock_updated_at  last change to `stock`, tracked separately so a price
 *                     edit synced down from home cannot resurrect a stale
 *                     quantity from before today's sales.
 */
function migrateProducts() {
  addColumnIfMissing('products', 'uuid', 'TEXT')
  addColumnIfMissing('products', 'stock', 'INTEGER NOT NULL DEFAULT 0')
  // Defaults to 1 (tracked). Things sold loose — frijol por kilo, bolsas — get
  // turned off so they stop reporting AGOTADO forever and drowning the real
  // warnings. See src/lib/stock.ts for why that matters.
  addColumnIfMissing('products', 'track_stock', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('products', 'updated_at', 'TEXT')
  addColumnIfMissing('products', 'stock_updated_at', 'TEXT')

  // Backfill identities for rows that predate the sync work.
  const orphans = db.prepare('SELECT id FROM products WHERE uuid IS NULL').all()
  if (orphans.length > 0) {
    const stamp = now()
    const fill = db.prepare(
      `UPDATE products SET uuid = ?,
              updated_at = COALESCE(updated_at, ?),
              stock_updated_at = COALESCE(stock_updated_at, ?)
        WHERE id = ?`
    )
    for (const row of orphans) fill.run(crypto.randomUUID(), stamp, stamp, row.id)
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_uuid ON products(uuid)')
}

/**
 * Sales gained a payment split once the card terminal arrived.
 *
 * Before this, `total_cents` doubled as "money in the drawer", which is only
 * true while every sale is cash. The moment one sale is paid with a Clip, the
 * corte claims cash that never physically arrived and the drawer will not
 * reconcile at closing time.
 *
 * So the split is the source of truth and the method is derived from it:
 *
 *   cash_cents + card_cents === total_cents, always.
 *
 * There is deliberately no way to record "card" while still crediting the
 * drawer — the two numbers are what the drawer and the reports both read, so
 * they cannot disagree with each other.
 *
 *   payment_method      'cash' | 'card' | 'mixed'. A label, for display only.
 *   cash_cents          stays in the drawer (total minus change, not the amount
 *                       handed over).
 *   card_cents          went through the terminal.
 *   terminal_provider   which terminal took it ('manual', 'clip', ...).
 *   terminal_reference  the authorisation number on the terminal's own slip.
 *                       The only thing the store can take to Clip when a charge
 *                       is disputed, which is why the payment screen insists on
 *                       it before a card sale may close.
 *   card_brand/last4    what the customer will recognise on their statement.
 */
function migrateSales() {
  addColumnIfMissing('sales', 'payment_method', "TEXT NOT NULL DEFAULT 'cash'")
  // Nullable so the backfill below can tell "not migrated yet" from "genuinely
  // zero cash", which a card sale legitimately is.
  addColumnIfMissing('sales', 'cash_cents', 'INTEGER')
  addColumnIfMissing('sales', 'card_cents', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('sales', 'terminal_provider', 'TEXT')
  addColumnIfMissing('sales', 'terminal_reference', 'TEXT')
  addColumnIfMissing('sales', 'card_brand', 'TEXT')
  addColumnIfMissing('sales', 'card_last4', 'TEXT')

  // Everything that predates the terminal was cash by definition: it is the
  // only way the register could take money. Backfilling the full total is
  // therefore exact, not a guess.
  db.exec('UPDATE sales SET cash_cents = total_cents WHERE cash_cents IS NULL')

  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_method ON sales(payment_method)')
}

/**
 * Cortes gained the same split, for the same reason.
 *
 * `total_cents` keeps meaning "everything sold in the period" so old rows and
 * old reports still read correctly. `cash_cents` is the new number that matters
 * at the counter: it is what the cashier physically counts out and hands over.
 */
function migrateCortes() {
  addColumnIfMissing('cortes', 'cash_cents', 'INTEGER')
  addColumnIfMissing('cortes', 'card_cents', 'INTEGER NOT NULL DEFAULT 0')

  // Cuts taken before the terminal existed were all cash, so their total is
  // their cash — the same reasoning as the sales backfill above.
  db.exec('UPDATE cortes SET cash_cents = total_cents WHERE cash_cents IS NULL')
}

function seedDefaults() {
  // INSERT OR IGNORE leaves the owner's choices alone on every later launch.
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  seed.run('printerName', 'POS58 Printer')
  seed.run('autoPrint', '1')
  seed.run('storeName', 'Abarrotes "El Paisa"')

  // $2,000 in the drawer before the register starts asking for a corte, and a
  // "getting low" mark of 3 units. Both are editable in Configuracion.
  seed.run('corteThresholdCents', '200000')
  seed.run('lowStockThreshold', '3')

  // Card terminal. Defaults to 'manual': the cashier charges on the terminal's
  // own keypad and types the authorisation number back here. That needs no
  // credentials and no internet, so it works from the first launch — see
  // electron/terminal.cjs for why the cloud drivers are opt-in.
  seed.run('terminalEnabled', '1')
  seed.run('terminalProvider', 'manual')
  seed.run('terminalAutoCharge', '0')
  seed.run('terminalApiUrl', '')
  seed.run('terminalApiKey', '')
  seed.run('terminalDeviceId', '')

  seed.run('syncEnabled', '0')
  seed.run('syncUrl', '')
  seed.run('syncKey', '')
  seed.run('syncStoreId', 'principal')
  seed.run('syncIntervalSec', '60')

  // Ships with 1234 and Configuracion can change it. The hash is salted per
  // install, so two registers with the same password do not share a hash.
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('configPasswordSalt')
  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex')
    seed.run('configPasswordSalt', salt)
    seed.run('configPasswordHash', hashPassword('1234', salt))
  }
}

/* ---------------------------------------------------------------- products */

const PRODUCT_COLUMNS = `id, uuid, barcode, name, price_cents, image_file, stock,
                         track_stock, updated_at, stock_updated_at`

function listProducts() {
  return db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE`
  ).all()
}

function getProduct(id) {
  return db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(id)
}

function findByBarcode(barcode) {
  return db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE barcode = ? AND active = 1`
  ).get(barcode)
}

/** Queues an outbox row. Callers are expected to already be inside a transaction. */
function enqueue(entity, entityUuid, payload, at) {
  db.prepare(
    'INSERT INTO outbox (entity, entity_uuid, payload, created_at) VALUES (?, ?, ?, ?)'
  ).run(entity, entityUuid, JSON.stringify(payload), at || now())
}

/** The shape pushed to the server for a product. Stock is deliberately absent. */
function productPayload(row, deleted) {
  return {
    uuid: row.uuid,
    barcode: row.barcode,
    name: row.name,
    priceCents: row.price_cents,
    imageFile: row.image_file,
    active: deleted ? 0 : 1,
    trackStock: row.track_stock,
    updatedAt: row.updated_at,
  }
}

function createProduct({ barcode, name, priceCents, imageFile, stock, trackStock }) {
  const uuid = crypto.randomUUID()
  const at = now()
  const qty = Number.isFinite(Number(stock)) ? Math.trunc(Number(stock)) : 0
  const tracked = trackStock === false || trackStock === 0 ? 0 : 1

  db.exec('BEGIN')
  try {
    const info = db.prepare(
      `INSERT INTO products (uuid, barcode, name, price_cents, image_file, stock,
                             track_stock, created_at, updated_at, stock_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid, barcode || null, name, priceCents, imageFile || null, qty, tracked, at, at, at)

    const row = getProduct(info.lastInsertRowid)
    enqueue('product', uuid, productPayload(row, false), at)
    enqueue('stock', uuid, { uuid, stock: qty, updatedAt: at }, at)
    db.exec('COMMIT')
    return row
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function updateProduct(id, { barcode, name, priceCents, imageFile, trackStock }) {
  const at = now()
  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE products SET barcode = ?, name = ?, price_cents = ?,
              image_file = COALESCE(?, image_file),
              track_stock = COALESCE(?, track_stock), updated_at = ?
        WHERE id = ?`
    ).run(
      barcode || null, name, priceCents, imageFile || null,
      trackStock === undefined || trackStock === null ? null : (trackStock ? 1 : 0), at, id
    )

    const row = getProduct(id)
    enqueue('product', row.uuid, productPayload(row, false), at)
    db.exec('COMMIT')
    return row
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// Soft delete: hard-deleting would orphan the history in sale_items.
function deactivateProduct(id) {
  const at = now()
  db.exec('BEGIN')
  try {
    const row = getProduct(id)
    db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(at, id)
    if (row) enqueue('product', row.uuid, productPayload({ ...row, updated_at: at }, true), at)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/* --------------------------------------------------------------- inventory */

function listInventory() {
  return db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE`
  ).all()
}

/**
 * Sets an absolute quantity — what the inventory screen does after a physical
 * count. `stock` rides its own outbox entity so it merges independently of a
 * name or price edit made somewhere else.
 */
function setStock(id, stock) {
  const at = now()
  const qty = Math.trunc(Number(stock) || 0)

  db.exec('BEGIN')
  try {
    db.prepare('UPDATE products SET stock = ?, stock_updated_at = ? WHERE id = ?').run(qty, at, id)
    const row = getProduct(id)
    enqueue('stock', row.uuid, { uuid: row.uuid, stock: qty, updatedAt: at }, at)
    db.exec('COMMIT')
    return row
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Turns stock tracking on or off for one product. Rides the `product` entity
 * rather than `stock`, because it is a fact about the product, not a quantity.
 */
function setTrackStock(id, tracked) {
  const at = now()
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE products SET track_stock = ?, updated_at = ? WHERE id = ?')
      .run(tracked ? 1 : 0, at, id)
    const row = getProduct(id)
    enqueue('product', row.uuid, productPayload(row, false), at)
    db.exec('COMMIT')
    return row
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Bulk form of setStock: one transaction for a whole physical count. */
function setStockBulk(entries) {
  const at = now()
  db.exec('BEGIN')
  try {
    const update = db.prepare('UPDATE products SET stock = ?, stock_updated_at = ? WHERE id = ?')
    for (const entry of entries) {
      const qty = Math.trunc(Number(entry.stock) || 0)
      update.run(qty, at, entry.id)
      const row = getProduct(entry.id)
      if (row) enqueue('stock', row.uuid, { uuid: row.uuid, stock: qty, updatedAt: at }, at)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return listInventory()
}

/* ------------------------------------------------------------------- sales */

/**
 * Settles the payment split for a sale before it is written.
 *
 * The renderer already validates the tender (src/lib/tender.ts), but this is
 * the last gate before the numbers become permanent, and the invariant it
 * enforces — cash + card === total — is the one thing the whole cash-drawer
 * report rests on. Enforcing it here rather than trusting the caller means a
 * future caller (the screenshot harness, a repair script, a second UI) cannot
 * quietly write a sale that makes the corte wrong.
 *
 * A caller that says nothing about payment gets the historical behaviour: all
 * cash. That is what every sale before the terminal existed actually was.
 */
function normalisePayment({
  totalCents, receivedCents, changeCents, cashCents, cardCents, paymentMethod, terminal,
}) {
  const total = Math.trunc(Number(totalCents) || 0)
  let card = Math.trunc(Number(cardCents) || 0)

  // Clamp rather than reject. A sale is already rung up and the customer is
  // standing there; refusing to record it would lose the money entirely, which
  // is strictly worse than recording it with the split pulled back into range.
  if (card < 0) card = 0
  if (card > total) card = total

  const cash = cashCents === undefined || cashCents === null
    ? total - card
    : Math.trunc(Number(cashCents) || 0)

  // If the caller's own split does not add up, its card leg is the number we
  // trust — that one is backed by an authorisation from the terminal, while the
  // cash leg is only ever what someone typed.
  const settledCash = cash + card === total ? cash : total - card

  const method = card <= 0 ? 'cash' : settledCash <= 0 ? 'card' : 'mixed'

  // Received/change only describe the cash leg. On a pure card sale no bills
  // changed hands at all, so both are zero regardless of what was passed.
  const received = method === 'card'
    ? 0
    : Math.trunc(Number(receivedCents) || 0) || settledCash
  const change = method === 'card' ? 0 : Math.max(0, received - settledCash)

  // `paymentMethod` from the caller is accepted but never trusted: the label is
  // always re-derived from the split, so a mislabelled sale is impossible.
  void paymentMethod

  const t = terminal || null
  return {
    method,
    cashCents: settledCash,
    cardCents: card,
    receivedCents: received,
    changeCents: change,
    terminalProvider: card > 0 ? (t && t.provider ? String(t.provider) : 'manual') : null,
    terminalReference: card > 0 && t && t.reference ? String(t.reference).slice(0, 40) : null,
    cardBrand: card > 0 && t && t.cardBrand ? String(t.cardBrand).slice(0, 20) : null,
    cardLast4: card > 0 && t && t.cardLast4 ? String(t.cardLast4).slice(-4) : null,
  }
}

/**
 * Records a completed sale. Sale, line items, stock decrements and outbox rows
 * all commit together, so the register can never end up with a sale that never
 * gets synced, or stock that drifts from the sales that caused it.
 */
function recordSale({
  items, totalCents, receivedCents, changeCents,
  cashCents, cardCents, paymentMethod, terminal,
}) {
  const uuid = crypto.randomUUID()
  const createdAt = now()
  const payment = normalisePayment({
    totalCents, receivedCents, changeCents, cashCents, cardCents, paymentMethod, terminal,
  })

  db.exec('BEGIN')
  try {
    const info = db.prepare(
      `INSERT INTO sales (uuid, total_cents, received_cents, change_cents,
                          payment_method, cash_cents, card_cents,
                          terminal_provider, terminal_reference, card_brand, card_last4,
                          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid, totalCents, payment.receivedCents, payment.changeCents,
      payment.method, payment.cashCents, payment.cardCents,
      payment.terminalProvider, payment.terminalReference,
      payment.cardBrand, payment.cardLast4,
      createdAt
    )
    const saleId = info.lastInsertRowid

    const insertItem = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, name, unit_price_cents, qty)
       VALUES (?, ?, ?, ?, ?)`
    )
    const decrement = db.prepare(
      'UPDATE products SET stock = stock - ?, stock_updated_at = ? WHERE id = ?'
    )

    for (const it of items) {
      insertItem.run(saleId, it.productId ?? null, it.name, it.unitPriceCents, it.qty)

      // A cart line can point at a product that was since deleted, or be a
      // manual entry with no product at all; those have no stock to move.
      // Untracked products (sold by weight) have no unit count to move, so
      // they are left alone rather than driven meaninglessly negative.
      if (it.productId != null) {
        const before = getProduct(it.productId)
        if (before && before.track_stock) {
          decrement.run(it.qty, createdAt, it.productId)
          const row = getProduct(it.productId)
          enqueue('stock', row.uuid, { uuid: row.uuid, stock: row.stock, updatedAt: createdAt }, createdAt)
        }
      }
    }

    enqueue('sale', uuid, {
      uuid, createdAt, totalCents,
      receivedCents: payment.receivedCents,
      changeCents: payment.changeCents,
      paymentMethod: payment.method,
      cashCents: payment.cashCents,
      cardCents: payment.cardCents,
      terminalProvider: payment.terminalProvider,
      terminalReference: payment.terminalReference,
      cardBrand: payment.cardBrand,
      cardLast4: payment.cardLast4,
      items,
    }, createdAt)

    db.exec('COMMIT')
    return { id: Number(saleId), uuid, createdAt, ...payment }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Queues everything this register currently holds.
 *
 * The outbox only ever gains rows when something *happens* — a product is
 * created, a sale is rung up, a count is corrected. A till that was already
 * running before cloud sync existed therefore has a full catalogue and a
 * completely empty outbox, so its first sync pushes nothing and the server
 * stays empty forever. Migration backfills each product's uuid so it *can*
 * sync; this is what actually offers it.
 *
 * Safe to run more than once: every entity is keyed by uuid, so the server
 * upserts duplicates and ignores sales it already has.
 */
function enqueueFullSnapshot({ includeHistory = true } = {}) {
  const at = now()
  const counts = { products: 0, stock: 0, sales: 0, cortes: 0 }

  db.exec('BEGIN')
  try {
    for (const row of db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE active = 1`).all()) {
      enqueue('product', row.uuid, productPayload(row, false), at)
      counts.products++

      // Goods sold loose have no unit count worth sending.
      if (row.track_stock) {
        enqueue('stock', row.uuid, {
          uuid: row.uuid,
          stock: row.stock,
          // Its own timestamp, not now(): if the server already holds a newer
          // count, last-write-wins should keep the server's rather than let a
          // resend stamp today's date on yesterday's number.
          updatedAt: row.stock_updated_at || at,
        }, at)
        counts.stock++
      }
    }

    if (includeHistory) {
      // Line items fetched in one pass and grouped in memory; a query per sale
      // would be thousands of round trips on a till with a year of history.
      const itemsBySale = new Map()
      for (const it of db.prepare(
        'SELECT sale_id, product_id, name, unit_price_cents, qty FROM sale_items'
      ).all()) {
        if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, [])
        itemsBySale.get(it.sale_id).push({
          productId: it.product_id,
          name: it.name,
          unitPriceCents: it.unit_price_cents,
          qty: it.qty,
        })
      }

      for (const sale of db.prepare(
        `SELECT id, uuid, total_cents, received_cents, change_cents, payment_method,
                cash_cents, card_cents, terminal_provider, terminal_reference,
                card_brand, card_last4, created_at
           FROM sales`
      ).all()) {
        enqueue('sale', sale.uuid, {
          uuid: sale.uuid,
          createdAt: sale.created_at,
          totalCents: sale.total_cents,
          receivedCents: sale.received_cents,
          changeCents: sale.change_cents,
          paymentMethod: sale.payment_method,
          cashCents: sale.cash_cents,
          cardCents: sale.card_cents,
          terminalProvider: sale.terminal_provider,
          terminalReference: sale.terminal_reference,
          cardBrand: sale.card_brand,
          cardLast4: sale.card_last4,
          items: itemsBySale.get(sale.id) || [],
        }, sale.created_at)
        counts.sales++
      }

      for (const c of db.prepare(
        `SELECT uuid, total_cents, cash_cents, card_cents, sale_count, cashier,
                opened_at, created_at
           FROM cortes`
      ).all()) {
        enqueue('corte', c.uuid, {
          uuid: c.uuid,
          totalCents: c.total_cents,
          cashCents: c.cash_cents,
          cardCents: c.card_cents,
          saleCount: c.sale_count,
          cashier: c.cashier ?? null,
          openedAt: c.opened_at,
          createdAt: c.created_at,
        }, c.created_at)
        counts.cortes++
      }
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return counts
}

/* ------------------------------------------------------------------ cortes */

/** ISO timestamp the current cash period began: the last corte, or the epoch. */
function currentPeriodStart() {
  const last = db.prepare('SELECT created_at FROM cortes ORDER BY created_at DESC LIMIT 1').get()
  return last ? last.created_at : '1970-01-01T00:00:00.000Z'
}

/**
 * What is in the drawer right now.
 *
 * Cash taken is the *cash leg* of each sale, not its total: money that went
 * through the card terminal never entered this drawer and must not be counted
 * as though it did. Nor is it the amount handed over — the change went back out
 * of the same drawer.
 *
 * `totalCents` is still every peso sold in the period, because that is what the
 * owner means by "how did we do today". The two are only equal in an all-cash
 * period, and keeping them separate is exactly what stops the corte drifting.
 */
function getCashDrawer() {
  const openedAt = currentPeriodStart()
  const row = db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0) AS totalCents,
            COALESCE(SUM(cash_cents),  0) AS cashCents,
            COALESCE(SUM(card_cents),  0) AS cardCents,
            COUNT(*)                      AS saleCount,
            COALESCE(SUM(CASE WHEN card_cents > 0 THEN 1 ELSE 0 END), 0) AS cardSaleCount
       FROM sales WHERE created_at > ?`
  ).get(openedAt)

  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('corteThresholdCents')
  const thresholdCents = Number(raw ? raw.value : 0) || 0
  const cashCents = Number(row.cashCents)

  return {
    totalCents: Number(row.totalCents),
    cashCents,
    cardCents: Number(row.cardCents),
    saleCount: Number(row.saleCount),
    cardSaleCount: Number(row.cardSaleCount),
    openedAt,
    thresholdCents,
    // Measured against cash only. The reminder exists because a drawer full of
    // bills is a theft risk worth walking to the back for; card takings sitting
    // in a Clip account are not, and letting them trip the alarm would train
    // the cashier to ignore it.
    needsCorte: thresholdCents > 0 && cashCents >= thresholdCents,
  }
}

/**
 * Closes the current cash period and starts a new one.
 *
 * `cashier` is whoever is handing the cash over. It is stored with the cut and
 * pushed to the server so the owner can tell, months later, who closed which
 * drawer. A blank name is kept as NULL rather than an empty string: "nobody
 * typed one" and "someone typed nothing" should not look different upstream.
 */
function recordCorte({ cashier = null } = {}) {
  const drawer = getCashDrawer()
  const uuid = crypto.randomUUID()
  const createdAt = now()
  const who = String(cashier ?? '').trim().slice(0, 60) || null

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO cortes (uuid, total_cents, cash_cents, card_cents, sale_count,
                           cashier, opened_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid, drawer.totalCents, drawer.cashCents, drawer.cardCents,
      drawer.saleCount, who, drawer.openedAt, createdAt
    )

    enqueue('corte', uuid, {
      uuid,
      totalCents: drawer.totalCents,
      cashCents: drawer.cashCents,
      cardCents: drawer.cardCents,
      saleCount: drawer.saleCount,
      cashier: who,
      openedAt: drawer.openedAt,
      createdAt,
    }, createdAt)

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    uuid,
    createdAt,
    totalCents: drawer.totalCents,
    cashCents: drawer.cashCents,
    cardCents: drawer.cardCents,
    saleCount: drawer.saleCount,
    cashier: who,
    openedAt: drawer.openedAt,
  }
}

function listCortes(limit = 20) {
  return db.prepare(
    `SELECT uuid, total_cents, cash_cents, card_cents, sale_count, cashier,
            opened_at, created_at
       FROM cortes ORDER BY created_at DESC LIMIT ?`
  ).all(limit)
}

/* ---------------------------------------------------------------- settings */

// Secrets never cross the bridge to the renderer. The renderer's job is to ask
// "is this password right?", not to hold the material to answer that itself.
const PRIVATE_SETTINGS = new Set(['configPasswordHash', 'configPasswordSalt'])

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  return Object.fromEntries(
    rows.filter((r) => !PRIVATE_SETTINGS.has(r.key)).map((r) => [r.key, r.value])
  )
}

function getSettingRaw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : null
}

function setSetting(key, value) {
  if (PRIVATE_SETTINGS.has(key)) {
    throw new Error(`Refusing to set ${key} through the settings channel`)
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

function verifyPassword(password) {
  const salt = getSettingRaw('configPasswordSalt')
  const expected = getSettingRaw('configPasswordHash')
  if (!salt || !expected) return false

  const a = Buffer.from(hashPassword(password, salt), 'hex')
  const b = Buffer.from(expected, 'hex')
  // Constant-time compare. Overkill against a curious cashier, free to do right.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function setPassword(currentPassword, newPassword) {
  if (!verifyPassword(currentPassword)) {
    return { ok: false, error: 'Contraseña actual incorrecta' }
  }
  if (!newPassword || String(newPassword).length < 4) {
    return { ok: false, error: 'La nueva contraseña debe tener al menos 4 caracteres' }
  }

  const salt = crypto.randomBytes(16).toString('hex')
  const write = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  write.run('configPasswordSalt', salt)
  write.run('configPasswordHash', hashPassword(newPassword, salt))
  return { ok: true }
}

/* -------------------------------------------------------------------- sync */

function getSyncState() {
  const rows = db.prepare('SELECT key, value FROM sync_state').all()
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

function setSyncState(key, value) {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

function pendingOutbox(limit = 200) {
  return db.prepare(
    `SELECT id, entity, entity_uuid, payload, created_at
       FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?`
  ).all(limit)
}

function countPendingOutbox() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get()
  return Number(row.n)
}

function markOutboxSent(ids) {
  if (ids.length === 0) return
  const at = now()
  db.exec('BEGIN')
  try {
    const mark = db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?')
    for (const id of ids) mark.run(at, id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Applies one change pulled from the server.
 *
 * Both entities are last-write-wins on their own timestamp, which is exactly
 * why they are separate: editing a price at home at 09:00 must not roll `stock`
 * back to what it was at 09:00 after the register sold twenty units at 11:00.
 */
function applyRemoteChange(change) {
  const entity = change.entity
  const payload = change.payload
  if (!payload || !payload.uuid) return { applied: false }

  if (entity === 'product') {
    const existing = db.prepare('SELECT id, updated_at FROM products WHERE uuid = ?').get(payload.uuid)
    const incomingAt = payload.updatedAt || now()

    if (!existing) {
      // stock_updated_at is the epoch, not `incomingAt`: a product we have only
      // just heard about carries no stock information, so the `stock` message
      // that follows must be able to win even if it shares a millisecond.
      db.prepare(
        `INSERT INTO products (uuid, barcode, name, price_cents, image_file, active,
                               track_stock, stock, created_at, updated_at, stock_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(
        payload.uuid, payload.barcode || null, payload.name, payload.priceCents,
        payload.imageFile || null, payload.active === 0 ? 0 : 1,
        payload.trackStock === 0 || payload.trackStock === false ? 0 : 1,
        incomingAt, incomingAt, NO_STOCK_YET
      )
      return { applied: true, imageFile: payload.imageFile || null }
    }

    if (existing.updated_at && existing.updated_at >= incomingAt) return { applied: false }

    db.prepare(
      `UPDATE products SET barcode = ?, name = ?, price_cents = ?, image_file = ?,
              active = ?, track_stock = ?, updated_at = ? WHERE uuid = ?`
    ).run(
      payload.barcode || null, payload.name, payload.priceCents,
      payload.imageFile || null, payload.active === 0 ? 0 : 1,
      payload.trackStock === 0 || payload.trackStock === false ? 0 : 1,
      incomingAt, payload.uuid
    )
    return { applied: true, imageFile: payload.imageFile || null }
  }

  // A permanent delete from the admin page. Unlike the server, this database
  // keeps a real reference from sale_items to products, so the line items are
  // detached first: they already snapshot the name and unit price, which is
  // what a reprinted receipt actually needs. Losing product_id costs nothing a
  // receipt shows; deleting the product out from under it would corrupt one.
  if (entity === 'product-purge') {
    const existing = db.prepare('SELECT id FROM products WHERE uuid = ?').get(payload.uuid)
    if (!existing) return { applied: false }

    // Both statements or neither: foreign_keys is ON, so a delete that ran
    // without the detach would be rejected and leave the catalogue half-edited.
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE sale_items SET product_id = NULL WHERE product_id = ?').run(existing.id)
      db.prepare('DELETE FROM products WHERE id = ?').run(existing.id)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { applied: true }
  }

  if (entity === 'stock') {
    const existing = db.prepare('SELECT stock_updated_at FROM products WHERE uuid = ?').get(payload.uuid)
    if (!existing) return { applied: false }

    const incomingAt = payload.updatedAt || now()
    if (existing.stock_updated_at && existing.stock_updated_at >= incomingAt) return { applied: false }

    db.prepare('UPDATE products SET stock = ?, stock_updated_at = ? WHERE uuid = ?')
      .run(Math.trunc(Number(payload.stock) || 0), incomingAt, payload.uuid)
    return { applied: true }
  }

  // Sales and cortes are push-only: the register is the only place they happen.
  return { applied: false }
}

/** Local image filenames, so the sync worker can offer them to the server. */
function localImageFiles() {
  return db.prepare(
    'SELECT DISTINCT image_file FROM products WHERE image_file IS NOT NULL'
  ).all().map((r) => r.image_file)
}

module.exports = {
  openDatabase,
  getSettings,
  getSettingRaw,
  setSetting,
  verifyPassword,
  setPassword,
  listProducts,
  getProduct,
  findByBarcode,
  createProduct,
  updateProduct,
  deactivateProduct,
  listInventory,
  setStock,
  setTrackStock,
  setStockBulk,
  recordSale,
  enqueueFullSnapshot,
  getCashDrawer,
  recordCorte,
  listCortes,
  getSyncState,
  setSyncState,
  pendingOutbox,
  countPendingOutbox,
  markOutboxSent,
  applyRemoteChange,
  localImageFiles,
}
