const { ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const db = require('./db.cjs')
const printer = require('./printer.cjs')
const sync = require('./sync.cjs')

/**
 * Every channel the renderer can reach, in one place. main.cjs and the
 * screenshot harness both call this, so the harness can never drift out of
 * sync with the real app the way a hand-copied handler list does.
 */
function registerIpc({ imageDir }) {
  ipcMain.handle('products:list', () => db.listProducts())
  ipcMain.handle('products:findByBarcode', (_e, barcode) => db.findByBarcode(barcode) ?? null)
  ipcMain.handle('products:create', (_e, input) => db.createProduct(input))
  ipcMain.handle('products:update', (_e, id, input) => db.updateProduct(id, input))
  ipcMain.handle('products:deactivate', (_e, id) => db.deactivateProduct(id))
  ipcMain.handle('sales:record', (_e, sale) => db.recordSale(sale))

  /* ------------------------------------------------------------ inventory */

  ipcMain.handle('inventory:list', () => db.listInventory())
  ipcMain.handle('inventory:setStock', (_e, id, stock) => db.setStock(id, stock))
  ipcMain.handle('inventory:setTrackStock', (_e, id, tracked) => db.setTrackStock(id, tracked))
  ipcMain.handle('inventory:setStockBulk', (_e, entries) => db.setStockBulk(entries))

  /* ----------------------------------------------------------- cash/corte */

  ipcMain.handle('cash:drawer', () => db.getCashDrawer())
  ipcMain.handle('cash:listCortes', (_e, limit) => db.listCortes(limit))

  // Recording the corte and printing it are deliberately separate steps: the
  // cut is committed to SQLite first, so a printer that is out of paper costs
  // a slip of paper, never the record of the cash that was handed over.
  ipcMain.handle('cash:corte', async (_e, { print = true } = {}) => {
    const corte = db.recordCorte()
    const settings = db.getSettings()

    if (!print) return { corte, printed: { ok: true } }
    try {
      await printer.printCorte(settings.printerName, corte, settings.storeName)
      return { corte, printed: { ok: true } }
    } catch (err) {
      return { corte, printed: { ok: false, error: String(err.message ?? err) } }
    }
  })

  /* -------------------------------------------------------------- settings */

  ipcMain.handle('settings:get', () => db.getSettings())
  ipcMain.handle('settings:set', (_e, key, value) => {
    db.setSetting(key, value)
    // Sync cadence and credentials live in settings, so the worker has to be
    // re-armed whenever they change or the new interval never takes effect.
    if (String(key).startsWith('sync')) sync.reschedule()
    return db.getSettings()
  })

  // The renderer only ever learns yes or no. The hash and salt stay in the main
  // process, so a compromised renderer has nothing to take offline and crack.
  ipcMain.handle('settings:verifyPassword', (_e, password) => db.verifyPassword(password))
  ipcMain.handle('settings:setPassword', (_e, current, next) => db.setPassword(current, next))

  /* -------------------------------------------------------------- printing */

  ipcMain.handle('printer:list', () => printer.listPrinters())

  // Printing returns a result object rather than throwing across the bridge:
  // a dead printer must never look like a failed sale to the renderer.
  ipcMain.handle('printer:test', async (_e, printerName) => {
    try {
      await printer.printTestPage(printerName)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) }
    }
  })

  ipcMain.handle('printer:receipt', async (_e, sale) => {
    const settings = db.getSettings()
    try {
      await printer.printReceipt(settings.printerName, sale, settings.storeName)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) }
    }
  })

  /* ------------------------------------------------------------------ sync */

  ipcMain.handle('sync:status', () => sync.status())
  ipcMain.handle('sync:now', () => sync.syncNow({ force: true }))
  ipcMain.handle('sync:resendAll', () => sync.resendAll())
  ipcMain.handle('sync:test', (_e, config) => sync.testConnection(config))
  ipcMain.handle('sync:maintenance', () => sync.getMaintenance())
  ipcMain.handle('sync:backup', () => sync.runBackup())

  /* ---------------------------------------------------------------- images */

  // Opens a picker and copies the chosen image into user data, returning the
  // stored filename. Copying (not referencing) means the photo survives the
  // original file being moved or deleted off a USB stick.
  ipcMain.handle('images:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Elegir imagen del producto',
      properties: ['openFile'],
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (res.canceled || res.filePaths.length === 0) return null

    const src = res.filePaths[0]
    const ext = path.extname(src).toLowerCase() || '.png'
    const filename = `${crypto.randomUUID()}${ext}`
    fs.copyFileSync(src, path.join(imageDir, filename))
    return filename
  })
}

module.exports = { registerIpc }
