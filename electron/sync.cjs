const path = require('node:path')
const fs = require('node:fs')
const db = require('./db.cjs')

/**
 * Cloud sync worker.
 *
 * The register is never blocked by this. Every sale is already committed to
 * local SQLite before sync hears about it; this drains the `outbox` table when
 * the internet happens to be up, and pulls down edits made somewhere else (the
 * owner fixing a price or adding product photos from home).
 *
 * The protocol is deliberately tiny — one endpoint plus an image store — so the
 * server side is something you can run on a VPS without a framework. See
 * `server/README.md` for the reference implementation.
 *
 *   POST {url}/sync        push outbox changes, pull everything newer than a cursor
 *   GET  {url}/images      list filenames the server holds
 *   GET  {url}/images/:f   download one
 *   PUT  {url}/images/:f   upload one
 *
 * All of it is authenticated with `Authorization: Bearer {syncKey}`.
 */

const PUSH_BATCH = 200
const REQUEST_TIMEOUT_MS = 20000

let imageDir = null
let timer = null
let running = false
let notify = () => {}

function config() {
  const s = db.getSettings()
  return {
    enabled: s.syncEnabled === '1',
    url: String(s.syncUrl || '').replace(/\/+$/, ''),
    key: String(s.syncKey || ''),
    storeId: String(s.syncStoreId || 'principal'),
    // Pushed on every sync so the admin page can title itself with the name the
    // owner typed into Configuración, rather than one hardcoded on the server.
    storeName: String(s.storeName || ''),
    intervalSec: Math.max(15, Number(s.syncIntervalSec) || 60),
  }
}

/** Current state for the settings screen: never throws, always renderable. */
function status() {
  const cfg = config()
  const state = db.getSyncState()
  return {
    enabled: cfg.enabled,
    configured: Boolean(cfg.url),
    pending: db.countPendingOutbox(),
    lastSyncAt: state.lastSyncAt || null,
    lastError: state.lastError || null,
    cursor: state.cursor || null,
    running,
  }
}

async function request(cfg, route, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${cfg.url}${route}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'X-Store-Id': cfg.storeId,
        ...(options.headers || {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
    }
    return res
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Pushes queued changes and applies whatever the server sends back.
 * Outbox rows are only marked sent after the server has acknowledged them, so a
 * connection that dies mid-request costs a duplicate push, never a lost sale.
 * (Every entity is keyed by uuid, so the server upserts duplicates harmlessly.)
 */
async function pushAndPull(cfg) {
  const pending = db.pendingOutbox(PUSH_BATCH)
  const state = db.getSyncState()

  const res = await request(cfg, '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: cfg.storeId,
      storeName: cfg.storeName || null,
      since: state.cursor || null,
      changes: pending.map((row) => ({
        entity: row.entity,
        uuid: row.entity_uuid,
        at: row.created_at,
        payload: JSON.parse(row.payload),
      })),
    }),
  })

  const body = await res.json()

  db.markOutboxSent(pending.map((r) => r.id))

  let applied = 0
  for (const change of body.changes || []) {
    try {
      if (db.applyRemoteChange(change).applied) applied++
    } catch (err) {
      // One malformed row from the server must not stall the whole drain.
      console.error('[sync] could not apply remote change', change && change.entity, err.message)
    }
  }

  if (body.cursor) db.setSyncState('cursor', body.cursor)
  return { pushed: pending.length, applied }
}

/**
 * Makes both sides hold the same image files.
 *
 * This is what lets the owner add product photos from home: the server ends up
 * with the file, the register notices it is referenced but missing locally, and
 * downloads it on the next cycle.
 */
async function reconcileImages(cfg) {
  if (!imageDir) return { uploaded: 0, downloaded: 0 }

  const remote = new Set((await (await request(cfg, '/images')).json()).files || [])
  const local = new Set(fs.readdirSync(imageDir))
  const referenced = db.localImageFiles()

  let uploaded = 0
  let downloaded = 0

  // Upload photos taken at the register that the server has never seen.
  for (const name of referenced) {
    if (!local.has(name) || remote.has(name)) continue
    const bytes = fs.readFileSync(path.join(imageDir, name))
    await request(cfg, `/images/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
    uploaded++
  }

  // Download photos attached from home to products we now know about.
  for (const name of referenced) {
    if (local.has(name) || !remote.has(name)) continue
    const res = await request(cfg, `/images/${encodeURIComponent(name)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    // Write beside the target then rename, so a half-downloaded photo is never
    // visible to the renderer's posimg:// handler.
    const tmp = path.join(imageDir, `.${name}.part`)
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, path.join(imageDir, name))
    downloaded++
  }

  return { uploaded, downloaded }
}

/**
 * One full cycle. Never throws: a dead server is an expected state for a shop
 * on domestic internet, so it is recorded and retried, not surfaced as a crash.
 */
async function syncNow({ force = false } = {}) {
  const cfg = config()

  if (!force && !cfg.enabled) return { ok: false, skipped: 'disabled' }
  if (!cfg.url) return { ok: false, error: 'Falta la dirección del servidor' }
  if (running) return { ok: false, skipped: 'running' }

  running = true
  notify(status())
  try {
    // First run against a server: offer everything this register already holds.
    // A till that predates cloud sync has a full catalogue and an empty outbox,
    // because nothing ever queued those rows. Without this the first sync
    // reports "enviados 0" and the server stays empty no matter how long it runs.
    if (!db.getSyncState().backfilled) {
      const queued = db.enqueueFullSnapshot({ includeHistory: true })
      db.setSyncState('backfilled', '1')
      console.log('[sync] first run, queued existing data:', JSON.stringify(queued))
    }

    const moved = await pushAndPull(cfg)
    const images = await reconcileImages(cfg)

    db.setSyncState('lastSyncAt', new Date().toISOString())
    db.setSyncState('lastError', '')
    return { ok: true, ...moved, ...images }
  } catch (err) {
    const message = String(err.message || err)
    db.setSyncState('lastError', message)
    return { ok: false, error: message }
  } finally {
    running = false
    notify(status())
  }
}

/** (Re)arms the background timer to match the current settings. */
function reschedule() {
  if (timer) clearInterval(timer)
  timer = null

  const cfg = config()
  if (!cfg.enabled || !cfg.url) return

  timer = setInterval(() => {
    syncNow().catch(() => {})
  }, cfg.intervalSec * 1000)
  // Timers must not keep Electron alive on quit.
  if (timer.unref) timer.unref()
}

function start(options) {
  imageDir = options.imageDir
  notify = options.notify || (() => {})
  reschedule()
  // A first pass shortly after boot catches anything queued while the shop was
  // closed, without competing with window creation for the CPU.
  setTimeout(() => { syncNow().catch(() => {}) }, 5000).unref?.()
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * Re-offers everything to the server, then syncs.
 *
 * The recovery path for "the server is missing things it should have" — a
 * catalogue that predates sync, or a server restored from an older backup.
 * Duplicates are harmless: every entity is keyed by uuid and upserted.
 */
async function resendAll() {
  const cfg = config()
  if (!cfg.url) return { ok: false, error: 'Falta la dirección del servidor' }

  const queued = db.enqueueFullSnapshot({ includeHistory: true })
  db.setSyncState('backfilled', '1')
  const result = await syncNow({ force: true })
  return { ...result, queued }
}

/**
 * Server-side maintenance state for the Respaldos tab.
 *
 * Backups live on the server, not the register — the whole point is that they
 * survive this machine. The register is only a viewer, so these calls are thin
 * pass-throughs that never throw: a shop with the internet down should see
 * "no se pudo conectar", not a broken settings screen.
 */
async function getMaintenance() {
  const cfg = config()
  if (!cfg.url) return { ok: false, error: 'Falta la dirección del servidor' }
  try {
    const body = await (await request(cfg, '/api/maintenance')).json()
    return { ok: true, status: body.status }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

async function runBackup() {
  const cfg = config()
  if (!cfg.url) return { ok: false, error: 'Falta la dirección del servidor' }
  try {
    const body = await (await request(cfg, '/api/backup', { method: 'POST' })).json()
    return body
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

/** Verifies a URL/key pair before the owner commits to saving them. */
async function testConnection({ url, key, storeId }) {
  const cfg = {
    url: String(url || '').replace(/\/+$/, ''),
    key: String(key || ''),
    storeId: String(storeId || 'principal'),
  }
  if (!cfg.url) return { ok: false, error: 'Falta la dirección del servidor' }

  try {
    const res = await request(cfg, '/health')
    const body = await res.json().catch(() => ({}))
    return { ok: true, server: body.server || 'ok', storeId: body.storeId || cfg.storeId }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

module.exports = {
  start, stop, reschedule, syncNow, status, testConnection,
  getMaintenance, runBackup, resendAll,
}
