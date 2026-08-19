/**
 * Reference sync server for the POS register.
 *
 * Runs on a VPS with nothing installed: Node's own HTTP server and Node's own
 * SQLite, no npm dependencies at all. That is deliberate — the store's data
 * should not stop syncing because a transitive dependency broke.
 *
 *   POS_SYNC_KEY=some-long-secret node server/server.mjs
 *
 * Environment:
 *   POS_SYNC_KEY    required. The shared secret the register sends as a bearer
 *                   token. Refuses to start without one.
 *   PORT            default 8787
 *   POS_DATA_DIR    default ./data — holds server.db and images/
 *
 * Endpoints (all except /health and / need `Authorization: Bearer <key>`):
 *   GET  /health                    liveness + version, used by "Probar conexión"
 *   POST /sync                      push register changes, pull everything newer
 *   GET  /images                    filenames held here
 *   GET  /images/:file              download one
 *   PUT  /images/:file              upload one
 *   GET  /api/products              admin UI: list
 *   POST /api/products              admin UI: create
 *   PUT  /api/products/:uuid        admin UI: edit name/price/barcode/stock
 *   POST /api/products/:uuid/image  admin UI: attach a photo (raw image bytes)
 *   DELETE /api/products/:uuid      admin UI: deactivate
 *   GET  /api/sales                 admin UI: recent sales
 *   GET  /api/cortes                admin UI: recent cash cuts
 *   GET  /api/maintenance           backup/purge status and the backup list
 *   POST /api/backup                take a snapshot now
 *   POST /api/purge                 run retention now (pass {"dryRun":true} to preview)
 *   GET  /api/backups/:file         download a snapshot
 *   GET  /                          the admin page itself
 *
 * Backups and purging:
 *   POS_BACKUP_ENABLED   1        snapshot the database on a timer
 *   POS_BACKUP_INTERVAL  5m       how often (30s / 5m / 6h / 1d)
 *   POS_BACKUP_KEEP      48       how many snapshots to retain
 *   POS_BACKUP_DIR       <data>/backups
 *   POS_PURGE_ENABLED    0        OFF by default: this deletes history
 *   POS_PURGE_INTERVAL   1d
 *   POS_PURGE_DAYS       365      drop sales and cortes older than this
 *   POS_PURGE_CHANGES_DAYS 30     drop sync-feed rows older than this
 *   POS_STALE_STORE_DAYS 30       a register unseen this long stops holding
 *                                 the sync feed open
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8787
const KEY = process.env.POS_SYNC_KEY
const DATA_DIR = process.env.POS_DATA_DIR || path.join(HERE, 'data')
const IMAGE_DIR = path.join(DATA_DIR, 'images')
const BACKUP_DIR = process.env.POS_BACKUP_DIR || path.join(DATA_DIR, 'backups')

/** Accepts `30s`, `5m`, `6h`, `1d`, or a plain number of milliseconds. */
function duration(text, fallbackMs) {
  const m = /^\s*(\d+)\s*([smhd]?)\s*$/.exec(String(text ?? ''))
  if (!m) return fallbackMs
  const value = Number(m[1])
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] ?? 1
  return value * unit
}

const flag = (name, dflt) => (process.env[name] ?? dflt) === '1'
const num = (name, dflt) => Number(process.env[name] ?? dflt) || dflt

const BACKUP = {
  enabled: flag('POS_BACKUP_ENABLED', '1'),
  intervalMs: duration(process.env.POS_BACKUP_INTERVAL, 5 * 60e3),
  keep: num('POS_BACKUP_KEEP', 48),
}

const PURGE = {
  // Off by default. This deletes history permanently, so it is opt-in.
  enabled: flag('POS_PURGE_ENABLED', '0'),
  intervalMs: duration(process.env.POS_PURGE_INTERVAL, 86400e3),
  days: num('POS_PURGE_DAYS', 365),
  changesDays: num('POS_PURGE_CHANGES_DAYS', 30),
  staleStoreDays: num('POS_STALE_STORE_DAYS', 30),
}

if (!KEY) {
  console.error('POS_SYNC_KEY is required. Refusing to start an unauthenticated sync server.')
  process.exit(1)
}

fs.mkdirSync(IMAGE_DIR, { recursive: true })
fs.mkdirSync(BACKUP_DIR, { recursive: true })

const db = new DatabaseSync(path.join(DATA_DIR, 'server.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    uuid             TEXT PRIMARY KEY,
    barcode          TEXT,
    name             TEXT    NOT NULL,
    price_cents      INTEGER NOT NULL,
    image_file       TEXT,
    active           INTEGER NOT NULL DEFAULT 1,
    stock            INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT    NOT NULL,
    stock_updated_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sales (
    uuid           TEXT PRIMARY KEY,
    store_id       TEXT    NOT NULL,
    total_cents    INTEGER NOT NULL,
    received_cents INTEGER NOT NULL,
    change_cents   INTEGER NOT NULL,
    items          TEXT    NOT NULL,
    created_at     TEXT    NOT NULL
  );

  -- Mirrors electron/db.cjs. cash_cents + card_cents = total_cents, and the
  -- method is derived from that split rather than stored as the truth, so a
  -- report here can never disagree with the register about where money went.

  CREATE TABLE IF NOT EXISTS cortes (
    uuid        TEXT PRIMARY KEY,
    store_id    TEXT    NOT NULL,
    total_cents INTEGER NOT NULL,
    sale_count  INTEGER NOT NULL,
    -- Name typed at the register when the cut was taken. Nullable: cuts pushed
    -- by a till that predates the field arrive without one.
    cashier     TEXT,
    opened_at   TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
  );

  -- The pull feed. Monotonic 'seq' is the cursor the register remembers, and
  -- 'origin' is who caused the change, so a register never gets its own writes
  -- echoed back at it on the very next poll.
  CREATE TABLE IF NOT EXISTS changes (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    entity  TEXT NOT NULL,
    uuid    TEXT NOT NULL,
    payload TEXT NOT NULL,
    at      TEXT NOT NULL,
    origin  TEXT NOT NULL
  );

  -- Which register has processed how much of the change feed. Without this the
  -- purge below could delete rows a register still needs and it would silently
  -- miss catalogue edits rather than erroring.
  CREATE TABLE IF NOT EXISTS stores (
    store_id     TEXT PRIMARY KEY,
    cursor       INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT    NOT NULL
  );

  -- Cash that moved for a reason other than a sale, mirroring the register's
  -- own table. Pushed up so the admin page can explain a corte that did not
  -- balance instead of only reporting that it did not.
  CREATE TABLE IF NOT EXISTS cash_movements (
    uuid         TEXT PRIMARY KEY,
    store_id     TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL,
    reason       TEXT    NOT NULL,
    person       TEXT,
    created_at   TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
  CREATE INDEX IF NOT EXISTS idx_cortes_created ON cortes(created_at);
  CREATE INDEX IF NOT EXISTS idx_changes_at ON changes(at);
  CREATE INDEX IF NOT EXISTS idx_movements_created ON cash_movements(created_at);
`)

// Goods sold loose have no unit count; see src/lib/stock.ts on the register.
const productCols = db.prepare('PRAGMA table_info(products)').all()
if (!productCols.some((c) => c.name === 'track_stock')) {
  db.exec('ALTER TABLE products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1')
}

// Servers that were already collecting cuts before the register asked who was
// on the till keep their rows; the older ones simply have no name.
const corteCols = db.prepare('PRAGMA table_info(cortes)').all()
if (!corteCols.some((c) => c.name === 'cashier')) {
  db.exec('ALTER TABLE cortes ADD COLUMN cashier TEXT')
}

/** SQLite has no ADD COLUMN IF NOT EXISTS, and dropping tables here loses history. */
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

// The payment split, added when the card terminal arrived. Everything already
// on this server predates the terminal and was therefore cash by definition, so
// backfilling the full total as cash is exact rather than a guess — the same
// reasoning as the register's own migration.
addColumnIfMissing('sales', 'payment_method', "TEXT NOT NULL DEFAULT 'cash'")
addColumnIfMissing('sales', 'cash_cents', 'INTEGER')
addColumnIfMissing('sales', 'card_cents', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('sales', 'terminal_provider', 'TEXT')
addColumnIfMissing('sales', 'terminal_reference', 'TEXT')
addColumnIfMissing('sales', 'card_brand', 'TEXT')
addColumnIfMissing('sales', 'card_last4', 'TEXT')
db.exec('UPDATE sales SET cash_cents = total_cents WHERE cash_cents IS NULL')

// The register tells us what the shop is called, so the admin page can put the
// owner's own name in its header instead of a hardcoded one. Registers that
// predate this simply have no name until their next sync.
addColumnIfMissing('stores', 'store_name', 'TEXT')

addColumnIfMissing('cortes', 'cash_cents', 'INTEGER')
addColumnIfMissing('cortes', 'card_cents', 'INTEGER NOT NULL DEFAULT 0')
db.exec('UPDATE cortes SET cash_cents = total_cents WHERE cash_cents IS NULL')

// The reconciliation, added when the register started asking the cashier to
// count the drawer. Mirrors electron/db.cjs column for column, and all of it
// nullable for the same reason: a cut taken before anyone was asked to count
// must stay readable rather than claim a count of zero nobody ever made.
addColumnIfMissing('cortes', 'float_start_cents', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('cortes', 'cash_in_cents', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('cortes', 'cash_out_cents', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('cortes', 'expected_cents', 'INTEGER')
addColumnIfMissing('cortes', 'counted_cents', 'INTEGER')
addColumnIfMissing('cortes', 'float_left_cents', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('cortes', 'difference_cents', 'INTEGER')
db.exec('UPDATE cortes SET expected_cents = cash_cents WHERE expected_cents IS NULL')

db.exec('CREATE INDEX IF NOT EXISTS idx_sales_method ON sales(payment_method)')

const now = () => new Date().toISOString()

// Sorts before every real timestamp, so the first `stock` message for a product
// always wins over the placeholder written when the row was created.
const NO_STOCK_YET = '1970-01-01T00:00:00.000Z'

function logChange(entity, uuid, payload, origin) {
  db.prepare('INSERT INTO changes (entity, uuid, payload, at, origin) VALUES (?, ?, ?, ?, ?)')
    .run(entity, uuid, JSON.stringify(payload), now(), origin)
}

/* ------------------------------------------------------------ merge rules */

/**
 * Last-write-wins per entity, exactly mirroring the register's own rule in
 * electron/db.cjs. Product metadata and stock carry separate timestamps so a
 * price edit made here cannot roll back stock the register decremented later.
 */
function applyProduct(payload, origin) {
  const incomingAt = payload.updatedAt || now()
  const existing = db.prepare('SELECT updated_at FROM products WHERE uuid = ?').get(payload.uuid)

  if (existing && existing.updated_at >= incomingAt) return false

  if (existing) {
    db.prepare(
      `UPDATE products SET barcode = ?, name = ?, price_cents = ?, image_file = ?,
              active = ?, track_stock = ?, updated_at = ? WHERE uuid = ?`
    ).run(
      payload.barcode ?? null, payload.name, payload.priceCents,
      payload.imageFile ?? null, payload.active === 0 ? 0 : 1,
      payload.trackStock === 0 || payload.trackStock === false ? 0 : 1,
      incomingAt, payload.uuid
    )
  } else {
    // stock_updated_at is the epoch, not `incomingAt`: a row we just learned
    // about carries no stock information, so the `stock` message that follows
    // this one (often in the same millisecond) must be able to win. Stamping it
    // with the product's own timestamp makes every new product sync as zero.
    db.prepare(
      `INSERT INTO products (uuid, barcode, name, price_cents, image_file, active,
                             track_stock, stock, updated_at, stock_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      payload.uuid, payload.barcode ?? null, payload.name, payload.priceCents,
      payload.imageFile ?? null, payload.active === 0 ? 0 : 1,
      payload.trackStock === 0 || payload.trackStock === false ? 0 : 1,
      incomingAt, NO_STOCK_YET
    )
  }

  logChange('product', payload.uuid, payload, origin)
  return true
}

function applyStock(payload, origin) {
  const incomingAt = payload.updatedAt || now()
  const existing = db.prepare('SELECT stock_updated_at FROM products WHERE uuid = ?').get(payload.uuid)
  if (!existing) return false
  if (existing.stock_updated_at >= incomingAt) return false

  db.prepare('UPDATE products SET stock = ?, stock_updated_at = ? WHERE uuid = ?')
    .run(Math.trunc(Number(payload.stock) || 0), incomingAt, payload.uuid)

  logChange('stock', payload.uuid, payload, origin)
  return true
}

/**
 * Fills in the payment split for a sale pushed by an older register.
 *
 * A till that has not been updated yet sends no split at all. Its sales were
 * all cash — that was the only way it could take money — so crediting the whole
 * total to cash is correct, not a fallback that quietly distorts the reports.
 */
function paymentOf(payload) {
  const total = Number(payload.totalCents) || 0
  const card = Number(payload.cardCents) || 0
  const cash = payload.cashCents === undefined || payload.cashCents === null
    ? total - card
    : Number(payload.cashCents)
  return {
    method: payload.paymentMethod || (card <= 0 ? 'cash' : cash <= 0 ? 'card' : 'mixed'),
    cash,
    card,
    provider: payload.terminalProvider ?? null,
    reference: payload.terminalReference ?? null,
    brand: payload.cardBrand ?? null,
    last4: payload.cardLast4 ?? null,
  }
}

function applySale(payload, storeId) {
  const pay = paymentOf(payload)
  db.prepare(
    `INSERT OR IGNORE INTO sales (uuid, store_id, total_cents, received_cents,
                                  change_cents, payment_method, cash_cents, card_cents,
                                  terminal_provider, terminal_reference, card_brand,
                                  card_last4, items, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    payload.uuid, storeId, payload.totalCents, payload.receivedCents,
    payload.changeCents, pay.method, pay.cash, pay.card,
    pay.provider, pay.reference, pay.brand, pay.last4,
    JSON.stringify(payload.items || []), payload.createdAt
  )
  // Not logged as a change: sales only ever flow upward.
  return true
}

function applyCorte(payload, storeId) {
  const total = Number(payload.totalCents) || 0
  const card = Number(payload.cardCents) || 0
  const cash = payload.cashCents === undefined || payload.cashCents === null
    ? total - card
    : Number(payload.cashCents)

  // A register that has not been updated yet sends no reconciliation at all.
  // Its cuts expected exactly the cash they reported — there was no fondo and
  // nowhere to record a movement — so filling that in is exact, and counted
  // stays null to say honestly that nobody was asked.
  const expected = payload.expectedCents === undefined || payload.expectedCents === null
    ? cash
    : Number(payload.expectedCents)

  db.prepare(
    `INSERT OR IGNORE INTO cortes (uuid, store_id, total_cents, cash_cents, card_cents,
                                   sale_count, cashier, opened_at, created_at,
                                   float_start_cents, cash_in_cents, cash_out_cents,
                                   expected_cents, counted_cents, float_left_cents,
                                   difference_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    payload.uuid, storeId, total, cash, card, payload.saleCount,
    payload.cashier ?? null, payload.openedAt, payload.createdAt,
    Number(payload.floatStartCents) || 0,
    Number(payload.cashInCents) || 0,
    Number(payload.cashOutCents) || 0,
    expected,
    payload.countedCents === undefined || payload.countedCents === null
      ? null
      : Number(payload.countedCents),
    Number(payload.floatLeftCents) || 0,
    payload.differenceCents === undefined || payload.differenceCents === null
      ? null
      : Number(payload.differenceCents)
  )
  return true
}

/** Cash in and out of the drawer. Push-only, like sales and cortes. */
function applyMovement(payload, storeId) {
  db.prepare(
    `INSERT OR IGNORE INTO cash_movements (uuid, store_id, kind, amount_cents,
                                           reason, person, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    payload.uuid, storeId, payload.kind === 'out' ? 'out' : 'in',
    Math.abs(Math.trunc(Number(payload.amountCents) || 0)),
    String(payload.reason ?? ''), payload.person ?? null, payload.createdAt
  )
  return true
}

/* ----------------------------------------------------- backups and purging */

const state = {
  lastBackupAt: null, lastBackupError: null,
  lastPurgeAt: null, lastPurgeError: null,
}

// Millisecond resolution, because a manual snapshot and the purge's own safety
// snapshot can land in the same second and must not overwrite each other.
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/[.]/g, '-').replace('T', '-').replace('Z', '')

/** Snapshots held right now, newest first. */
function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((name) => {
      const st = fs.statSync(path.join(BACKUP_DIR, name))
      return { name, bytes: st.size, createdAt: st.mtime.toISOString() }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * Takes a consistent snapshot with VACUUM INTO.
 *
 * Plain `cp` of a WAL database can capture a torn state — the -wal file holds
 * committed pages the .db file does not yet have. VACUUM INTO asks SQLite for a
 * single-file copy of a consistent view, and it does not block writers, so the
 * register can keep syncing while it runs.
 */
function runBackup() {
  // Belt and braces: if a name is somehow still taken, step aside rather than
  // clobbering an existing snapshot.
  let name = `server-${stamp(new Date())}.db`
  for (let i = 1; fs.existsSync(path.join(BACKUP_DIR, name)); i++) {
    name = `server-${stamp(new Date())}-${i}.db`
  }
  const target = path.join(BACKUP_DIR, name)

  try {
    // Written as a literal because VACUUM INTO takes no bind parameters; the
    // path is ours, never user input.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)

    // Retention by count, newest kept.
    const extra = listBackups().slice(BACKUP.keep)
    for (const old of extra) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true })

    state.lastBackupAt = new Date().toISOString()
    state.lastBackupError = null
    const st = fs.statSync(target)
    return { ok: true, backup: { name, bytes: st.size, createdAt: st.mtime.toISOString() }, pruned: extra.length }
  } catch (err) {
    state.lastBackupError = String(err.message || err)
    console.error('[backup]', state.lastBackupError)
    return { ok: false, error: state.lastBackupError }
  }
}

/**
 * The highest change `seq` it is safe to delete below.
 *
 * A register's cursor is a seq in the changes table. Delete rows underneath a
 * cursor still in use and that register does not error — it simply never sees
 * those catalogue edits again. So the feed is only trimmed below the oldest
 * cursor still in play, ignoring registers that have not been seen in
 * POS_STALE_STORE_DAYS (a decommissioned till must not freeze the feed forever).
 */
function safeChangeFloor() {
  const cutoff = new Date(Date.now() - PURGE.staleStoreDays * 86400e3).toISOString()
  const row = db.prepare(
    'SELECT MIN(cursor) AS floor FROM stores WHERE last_seen_at >= ?'
  ).get(cutoff)
  if (!row || row.floor === null) return Number.MAX_SAFE_INTEGER
  return Number(row.floor)
}

/**
 * Applies retention. Always backs up first and refuses to delete anything if
 * that backup failed — a year of sales is not something to lose to a full disk.
 */
function runPurge({ dryRun = false } = {}) {
  const cutoff = new Date(Date.now() - PURGE.days * 86400e3).toISOString()
  const changesCutoff = new Date(Date.now() - PURGE.changesDays * 86400e3).toISOString()
  const floor = safeChangeFloor()

  const counts = {
    sales: db.prepare('SELECT COUNT(*) AS n FROM sales WHERE created_at < ?').get(cutoff).n,
    cortes: db.prepare('SELECT COUNT(*) AS n FROM cortes WHERE created_at < ?').get(cutoff).n,
    changes: db.prepare('SELECT COUNT(*) AS n FROM changes WHERE at < ? AND seq < ?')
      .get(changesCutoff, floor).n,
  }

  if (dryRun) return { ok: true, dryRun: true, cutoff, changesCutoff, floor, wouldDelete: counts }

  const backup = runBackup()
  if (!backup.ok) {
    state.lastPurgeError = `Se canceló la limpieza: el respaldo falló (${backup.error})`
    console.error('[purge]', state.lastPurgeError)
    return { ok: false, error: state.lastPurgeError }
  }

  try {
    db.exec('BEGIN')
    db.prepare('DELETE FROM sales WHERE created_at < ?').run(cutoff)
    db.prepare('DELETE FROM cortes WHERE created_at < ?').run(cutoff)
    db.prepare('DELETE FROM changes WHERE at < ? AND seq < ?').run(changesCutoff, floor)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    state.lastPurgeError = String(err.message || err)
    console.error('[purge]', state.lastPurgeError)
    return { ok: false, error: state.lastPurgeError }
  }

  // Photos no product points at any more, given a week's grace so an upload
  // that has not been attached yet is never swept away mid-flight.
  const referenced = new Set(
    db.prepare('SELECT DISTINCT image_file FROM products WHERE image_file IS NOT NULL')
      .all().map((r) => r.image_file)
  )
  let images = 0
  const graceMs = Date.now() - 7 * 86400e3
  for (const file of fs.readdirSync(IMAGE_DIR)) {
    if (referenced.has(file)) continue
    const full = path.join(IMAGE_DIR, file)
    if (fs.statSync(full).mtimeMs > graceMs) continue
    fs.rmSync(full, { force: true })
    images++
  }

  state.lastPurgeAt = new Date().toISOString()
  state.lastPurgeError = null
  return { ok: true, deleted: { ...counts, images }, backup: backup.backup }
}

function maintenanceStatus() {
  let databaseBytes = 0
  try { databaseBytes = fs.statSync(path.join(DATA_DIR, 'server.db')).size } catch {}
  return {
    backupEnabled: BACKUP.enabled,
    backupIntervalMs: BACKUP.intervalMs,
    backupKeep: BACKUP.keep,
    lastBackupAt: state.lastBackupAt,
    lastBackupError: state.lastBackupError,
    purgeEnabled: PURGE.enabled,
    purgeDays: PURGE.days,
    changesDays: PURGE.changesDays,
    lastPurgeAt: state.lastPurgeAt,
    lastPurgeError: state.lastPurgeError,
    backups: listBackups(),
    databaseBytes,
  }
}

/* --------------------------------------------------------------- plumbing */

const json = (res, status, body) => {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(data)
}

function authorized(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(token)
  const b = Buffer.from(KEY)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('Payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Rejects traversal and separators outright rather than trying to sanitise. */
function safeImageName(raw) {
  const name = decodeURIComponent(raw || '')
  if (!name || name !== path.basename(name) || name.startsWith('.')) return null
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null
  return name
}

const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
}

/* ----------------------------------------------------------------- routes */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const route = url.pathname
  const method = req.method || 'GET'
  const storeId = String(req.headers['x-store-id'] || 'principal')

  try {
    // The admin page is a static shell: it holds no secret and asks the browser
    // for the key on load, so serving it unauthenticated is safe.
    if (route === '/' && method === 'GET') {
      const html = fs.readFileSync(path.join(HERE, 'admin.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    if (route === '/health' && method === 'GET') {
      return json(res, 200, { server: 'pos-sync', version: 1, storeId, time: now() })
    }

    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })

    /* ------------------------------------------------------ register sync */

    if (route === '/sync' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const origin = String(body.storeId || storeId)

      db.exec('BEGIN')
      try {
        for (const change of body.changes || []) {
          const payload = change.payload
          if (!payload) continue
          if (change.entity === 'product') applyProduct(payload, origin)
          else if (change.entity === 'stock') applyStock(payload, origin)
          else if (change.entity === 'sale') applySale(payload, origin)
          else if (change.entity === 'corte') applyCorte(payload, origin)
          else if (change.entity === 'movement') applyMovement(payload, origin)
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }

      // Everything newer than the register's cursor that it did not cause.
      const since = Number(body.since) || 0

      // Remember how far this register has got, so the purge never trims the
      // feed out from under it.
      // COALESCE keeps a name we already know when a sync arrives without one,
      // so an older register on the same store cannot blank it out.
      db.prepare(
        `INSERT INTO stores (store_id, cursor, last_seen_at, store_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(store_id) DO UPDATE SET
           cursor = MAX(cursor, excluded.cursor), last_seen_at = excluded.last_seen_at,
           store_name = COALESCE(excluded.store_name, stores.store_name)`
      ).run(origin, since, now(), body.storeName ? String(body.storeName).slice(0, 120) : null)
      const rows = db.prepare(
        `SELECT seq, entity, uuid, payload, at FROM changes
          WHERE seq > ? AND origin <> ? ORDER BY seq LIMIT 500`
      ).all(since, origin)

      const cursor = rows.length > 0 ? rows[rows.length - 1].seq : since
      return json(res, 200, {
        cursor: String(cursor),
        changes: rows.map((r) => ({
          entity: r.entity,
          uuid: r.uuid,
          at: r.at,
          payload: JSON.parse(r.payload),
        })),
      })
    }

    /* ----------------------------------------------------------- images */

    if (route === '/images' && method === 'GET') {
      return json(res, 200, { files: fs.readdirSync(IMAGE_DIR).filter((f) => !f.startsWith('.')) })
    }

    if (route.startsWith('/images/')) {
      const name = safeImageName(route.slice('/images/'.length))
      if (!name) return json(res, 400, { error: 'bad filename' })
      const file = path.join(IMAGE_DIR, name)

      if (method === 'GET') {
        if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' })
        res.writeHead(200, {
          'Content-Type': CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        })
        return res.end(fs.readFileSync(file))
      }

      if (method === 'PUT') {
        fs.writeFileSync(file, await readBody(req))
        return json(res, 200, { ok: true, file: name })
      }
    }

    /* ------------------------------------------------------- admin API */

    if (route === '/api/products' && method === 'GET') {
      return json(res, 200, {
        products: db.prepare('SELECT * FROM products ORDER BY active DESC, name COLLATE NOCASE').all(),
      })
    }

    if (route === '/api/products' && method === 'POST') {
      const input = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const at = now()
      const uuid = input.uuid || crypto.randomUUID()

      const tracked = input.trackStock === false || input.trackStock === 0 ? 0 : 1

      db.prepare(
        `INSERT INTO products (uuid, barcode, name, price_cents, image_file, active,
                               track_stock, stock, updated_at, stock_updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`
      ).run(uuid, input.barcode || null, input.name, Number(input.priceCents) || 0,
            tracked, Math.trunc(Number(input.stock) || 0), at, at)

      logChange('product', uuid, {
        uuid, barcode: input.barcode || null, name: input.name,
        priceCents: Number(input.priceCents) || 0, imageFile: null, active: 1,
        trackStock: tracked, updatedAt: at,
      }, 'admin')
      logChange('stock', uuid, { uuid, stock: Math.trunc(Number(input.stock) || 0), updatedAt: at }, 'admin')

      return json(res, 200, { ok: true, uuid })
    }

    const productMatch = route.match(/^\/api\/products\/([A-Za-z0-9-]+)(\/image)?$/)
    if (productMatch) {
      const uuid = productMatch[1]
      const isImage = Boolean(productMatch[2])
      const existing = db.prepare('SELECT * FROM products WHERE uuid = ?').get(uuid)
      if (!existing) return json(res, 404, { error: 'not found' })

      // Attaching a photo from home. The register notices the new filename on
      // its next pull and downloads the bytes itself.
      if (isImage && method === 'POST') {
        const bytes = await readBody(req)
        const type = String(req.headers['content-type'] || 'image/png')
        const ext = type.includes('jpeg') ? '.jpg'
          : type.includes('webp') ? '.webp'
          : type.includes('gif') ? '.gif' : '.png'
        const filename = `${crypto.randomUUID()}${ext}`
        fs.writeFileSync(path.join(IMAGE_DIR, filename), bytes)

        const at = now()
        db.prepare('UPDATE products SET image_file = ?, updated_at = ? WHERE uuid = ?')
          .run(filename, at, uuid)
        logChange('product', uuid, {
          uuid, barcode: existing.barcode, name: existing.name,
          priceCents: existing.price_cents, imageFile: filename,
          active: existing.active, trackStock: existing.track_stock, updatedAt: at,
        }, 'admin')

        return json(res, 200, { ok: true, imageFile: filename })
      }

      if (method === 'PUT') {
        const input = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const at = now()

        const tracked = input.trackStock === undefined || input.trackStock === null
          ? existing.track_stock
          : (input.trackStock ? 1 : 0)

        // `active` is how a deleted product comes back. Deleting is a soft
        // delete — hard-deleting would orphan the line items in `sale_items`
        // and rewrite history — so undoing it is just flipping this back to 1.
        const active = input.active === undefined || input.active === null
          ? existing.active
          : (input.active ? 1 : 0)

        db.prepare(
          `UPDATE products SET barcode = ?, name = ?, price_cents = ?,
                  track_stock = ?, active = ?, updated_at = ? WHERE uuid = ?`
        ).run(input.barcode || null, input.name, Number(input.priceCents) || 0,
              tracked, active, at, uuid)

        logChange('product', uuid, {
          uuid, barcode: input.barcode || null, name: input.name,
          priceCents: Number(input.priceCents) || 0, imageFile: existing.image_file,
          active, trackStock: tracked, updatedAt: at,
        }, 'admin')

        // Stock only moves if the admin actually typed a new number — otherwise
        // saving a price edit would stamp a stale count over the register's.
        if (input.stock !== undefined && input.stock !== null && input.stock !== '') {
          const qty = Math.trunc(Number(input.stock) || 0)
          db.prepare('UPDATE products SET stock = ?, stock_updated_at = ? WHERE uuid = ?').run(qty, at, uuid)
          logChange('stock', uuid, { uuid, stock: qty, updatedAt: at }, 'admin')
        }

        return json(res, 200, { ok: true })
      }

      if (method === 'DELETE') {
        const at = now()

        // Two different deletes, and the difference matters.
        //
        // The default is a SOFT delete: `active = 0`. The row stays, so a
        // reprinted receipt and the sales list still resolve the product, and
        // Restaurar is just flipping the flag back.
        //
        // `?hard=1` is the owner saying they want it gone for good — a typo, a
        // duplicate, something that never should have existed. That is safe
        // here because sales on this server snapshot their line items as JSON
        // rather than pointing at products(uuid), so removing the row rewrites
        // no history. The register keeps a real foreign key, so its own purge
        // detaches the line items first; see applyRemoteChange in db.cjs.
        if (url.searchParams.get('hard') === '1') {
          db.prepare('DELETE FROM products WHERE uuid = ?').run(uuid)

          // The photo would otherwise sit in the images directory forever, and
          // /images would keep advertising a file nothing references.
          if (existing.image_file) {
            const stillUsed = db.prepare('SELECT 1 FROM products WHERE image_file = ? LIMIT 1')
              .get(existing.image_file)
            if (!stillUsed) {
              try { fs.unlinkSync(path.join(IMAGE_DIR, existing.image_file)) } catch {}
            }
          }

          // A distinct entity rather than a `product` change with a flag: a
          // register that has not learned about purges must ignore this
          // outright instead of half-applying it as an ordinary edit.
          logChange('product-purge', uuid, { uuid, name: existing.name, updatedAt: at }, 'admin')
          return json(res, 200, { ok: true, purged: true })
        }

        db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE uuid = ?').run(at, uuid)
        logChange('product', uuid, {
          uuid, barcode: existing.barcode, name: existing.name,
          priceCents: existing.price_cents, imageFile: existing.image_file,
          active: 0, trackStock: existing.track_stock, updatedAt: at,
        }, 'admin')
        return json(res, 200, { ok: true })
      }
    }

    // What the shop calls itself, for the admin page header. Newest sync wins:
    // with one register there is only one answer, and with several the one that
    // reported most recently is the least stale.
    if (route === '/api/store' && method === 'GET') {
      const row = db.prepare(
        `SELECT store_id, store_name FROM stores
          WHERE store_name IS NOT NULL AND store_name <> ''
          ORDER BY last_seen_at DESC LIMIT 1`
      ).get()
      return json(res, 200, { name: row ? row.store_name : null, storeId: row ? row.store_id : null })
    }

    if (route === '/api/maintenance' && method === 'GET') {
      return json(res, 200, { status: maintenanceStatus() })
    }

    if (route === '/api/backup' && method === 'POST') {
      return json(res, 200, runBackup())
    }

    if (route === '/api/purge' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      return json(res, 200, runPurge({ dryRun: Boolean(body.dryRun) }))
    }

    if (route.startsWith('/api/backups/') && method === 'GET') {
      const name = safeImageName(route.slice('/api/backups/'.length))
      if (!name || !name.endsWith('.db')) return json(res, 400, { error: 'bad filename' })
      const file = path.join(BACKUP_DIR, name)
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' })
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
      })
      return res.end(fs.readFileSync(file))
    }

    if (route === '/api/sales' && method === 'GET') {
      const sales = db.prepare('SELECT * FROM sales ORDER BY created_at DESC LIMIT 100').all()
      // Totalled over the same 100 rows the table shows, so the figures at the
      // top always add up to the rows underneath them. A lifetime total that
      // disagrees with a visible list is the kind of thing that gets the whole
      // screen mistrusted.
      const totals = sales.reduce((acc, s) => ({
        totalCents: acc.totalCents + s.total_cents,
        cashCents: acc.cashCents + (s.cash_cents ?? s.total_cents),
        cardCents: acc.cardCents + (s.card_cents ?? 0),
        cardSales: acc.cardSales + ((s.card_cents ?? 0) > 0 ? 1 : 0),
      }), { totalCents: 0, cashCents: 0, cardCents: 0, cardSales: 0 })

      return json(res, 200, { sales, totals })
    }

    if (route === '/api/cortes' && method === 'GET') {
      return json(res, 200, {
        cortes: db.prepare('SELECT * FROM cortes ORDER BY created_at DESC LIMIT 100').all(),
      })
    }

    if (route === '/api/movements' && method === 'GET') {
      const movements = db.prepare(
        'SELECT * FROM cash_movements ORDER BY created_at DESC LIMIT 100'
      ).all()
      // Totalled over the same rows the table shows, for the same reason the
      // sales totals are: a figure at the top that disagrees with the list
      // underneath it gets the whole screen mistrusted.
      const totals = movements.reduce((acc, m) => ({
        inCents: acc.inCents + (m.kind === 'in' ? m.amount_cents : 0),
        outCents: acc.outCents + (m.kind === 'out' ? m.amount_cents : 0),
      }), { inCents: 0, outCents: 0 })

      return json(res, 200, { movements, totals })
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[server]', method, route, err)
    return json(res, 500, { error: String(err.message || err) })
  }
})

server.listen(PORT, () => {
  console.log(`pos-sync listening on :${PORT}`)
  console.log(`data dir: ${DATA_DIR}`)

  if (BACKUP.enabled) {
    console.log(`backups: every ${BACKUP.intervalMs / 1000}s, keeping ${BACKUP.keep}, in ${BACKUP_DIR}`)
    runBackup()
    setInterval(runBackup, BACKUP.intervalMs)
  } else {
    console.log('backups: disabled')
  }

  if (PURGE.enabled) {
    console.log(`purge: every ${PURGE.intervalMs / 1000}s, history ${PURGE.days}d, feed ${PURGE.changesDays}d`)
    setInterval(() => runPurge(), PURGE.intervalMs)
  } else {
    console.log('purge: disabled (set POS_PURGE_ENABLED=1 to turn on)')
  }
})

// A snapshot on the way out costs a second and covers the most likely moment to
// want one: right before a deploy or a restart.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (BACKUP.enabled) runBackup()
    process.exit(0)
  })
}
