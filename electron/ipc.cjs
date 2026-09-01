const { ipcMain, dialog, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const db = require('./db.cjs')
const printer = require('./printer.cjs')
const sync = require('./sync.cjs')
const terminal = require('./terminal.cjs')
const kiosk = require('./kiosk.cjs')

/**
 * Every channel the renderer can reach, in one place. main.cjs and the
 * screenshot harness both call this, so the harness can never drift out of
 * sync with the real app the way a hand-copied handler list does.
 */
function registerIpc({ imageDir }) {
  ipcMain.handle('products:list', () => db.listProducts())
  ipcMain.handle('products:findByBarcode', (_e, barcode) => db.findByBarcode(barcode) ?? null)
  ipcMain.handle('products:findByScaleCode', (_e, itemCode, prefix) =>
    db.findByScaleCode(itemCode, prefix) ?? null)
  ipcMain.handle('products:create', (_e, input) => db.createProduct(input))
  ipcMain.handle('products:update', (_e, id, input) => db.updateProduct(id, input))
  ipcMain.handle('products:deactivate', (_e, id) => db.deactivateProduct(id))
  /**
   * The one point in the pipeline where a transaction becomes real.
   *
   * `db.recordSale` re-derives the payment split and commits sale, line items,
   * stock and outbox in a single transaction. If it returns, the money is
   * recorded; if it throws, nothing happened at all. That makes the line after
   * it the only correct place to hang side effects that must not fire on a sale
   * that did not complete — see the cash drawer TODO below.
   */
  ipcMain.handle('sales:record', (_e, sale) => {
    const recorded = db.recordSale(sale)

    // TODO(you): open the cash drawer here, and *only* here.
    //
    // The drawer is a servo on an Arduino (see the sketch the owner wrote: it
    // sweeps pin 9 from 0° to 90° a degree at a time with a 20 ms delay, waits,
    // then sweeps back). To drive it from here the sketch needs to stop running
    // the sweep on a `loop()` timer and instead wait for a byte on the serial
    // port — otherwise the drawer opens every three seconds forever, which is
    // worse than not automating it at all. Roughly:
    //
    //     void loop() {
    //       if (Serial.available() && Serial.read() == 'O') {
    //         moverServoSuave(90);
    //         delay(1500);
    //         moverServoSuave(0);
    //       }
    //     }
    //
    // On this side that is one write to a COM port. `serialport` is the usual
    // package; keep the port name in settings next to `printerName`, since it
    // moves whenever the Arduino is replugged into a different USB socket.
    //
    // Two conditions, both of which matter:
    //
    //   1. ONLY after the sale has committed. Firing before this line means a
    //      failed insert still opens the drawer, which is an open till with no
    //      record of why — the exact hole a POS exists to close.
    //
    //   2. ONLY when cash actually changed hands: `recorded.cashCents > 0`.
    //      A pure card sale needs no drawer, and popping it anyway trains the
    //      cashier to leave it open, defeating the point. Mixed tenders DO need
    //      it — there is change to give.
    //
    // Failure must be swallowed the way printing is: an unplugged Arduino costs
    // the cashier a keypress to open the drawer by hand, never a recorded sale.
    // Which means it cannot be awaited here, and its error cannot propagate.
    //
    //     if (recorded.cashCents > 0) {
    //       drawer.pop().catch((err) => console.error('[drawer]', err.message))
    //     }
    //
    // Worth deciding while wiring it: should a corte (cash:corte below) open the
    // drawer too? The cashier is about to empty it, so probably yes — but that
    // is a second call site, not a change to this one.

    return recorded
  })

  /* ------------------------------------------------------------ inventory */

  ipcMain.handle('inventory:list', () => db.listInventory())
  ipcMain.handle('inventory:setStock', (_e, id, stock) => db.setStock(id, stock))
  ipcMain.handle('inventory:setTrackStock', (_e, id, tracked) => db.setTrackStock(id, tracked))
  ipcMain.handle('inventory:setStockBulk', (_e, entries) => db.setStockBulk(entries))

  /* ----------------------------------------------------------- cash/corte */

  ipcMain.handle('cash:drawer', () => db.getCashDrawer())
  ipcMain.handle('cash:listCortes', (_e, limit) => db.listCortes(limit))

  // Cash in and out of the drawer for reasons that are not sales. No password:
  // see the note on db.recordMovement for why locking it would only stop the
  // record being made, never the money leaving.
  ipcMain.handle('cash:movements', () => db.listMovements())
  ipcMain.handle('cash:movement', (_e, input) => db.recordMovement(input))

  // Recording the corte and printing it are deliberately separate steps: the
  // cut is committed to SQLite first, so a printer that is out of paper costs
  // a slip of paper, never the record of the cash that was handed over.
  ipcMain.handle('cash:corte', async (_e, {
    print = true, cashier = null, countedCents = null, floatLeftCents = 0,
  } = {}) => {
    const corte = db.recordCorte({ cashier, countedCents, floatLeftCents })
    const settings = db.getSettings()

    if (!print) return { corte, printed: { ok: true } }
    try {
      await printer.printCorte(settings.printerName, corte, settings.storeName)
      return { corte, printed: { ok: true } }
    } catch (err) {
      return { corte, printed: { ok: false, error: String(err.message ?? err) } }
    }
  })

  /* -------------------------------------------------------------- terminal */

  // Every one of these returns a result object rather than throwing. A card
  // terminal that cannot be reached must degrade to "type the auth code by
  // hand", never to an exception the payment screen has to catch mid-sale.

  ipcMain.handle('terminal:status', () => terminal.status())
  ipcMain.handle('terminal:charge', (_e, input) => terminal.charge(input))
  ipcMain.handle('terminal:poll', (_e, intentId) => terminal.poll(intentId))
  ipcMain.handle('terminal:cancel', (_e, intentId) => terminal.cancel(intentId))
  ipcMain.handle('terminal:test', (_e, config) => terminal.testConnection(config))

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

  /* ---------------------------------------------------------------- kiosk */

  // Unlocking is decided here for the same reason the password is checked here:
  // a renderer that could unlock itself is not a lock. The renderer may ask,
  // and it may be told no.
  ipcMain.handle('kiosk:state', () => ({
    locked: kiosk.isLocked(),
    kioskMode: kiosk.isArmed(),
    autoStart: kiosk.getAutoStart(),
  }))
  ipcMain.handle('kiosk:setMode', (_e, enabled) => kiosk.setKioskMode(enabled))
  ipcMain.handle('kiosk:unlock', (_e, password) => kiosk.unlock(password))
  ipcMain.handle('kiosk:relock', () => kiosk.relock())
  ipcMain.handle('kiosk:quit', () => kiosk.quit())
  ipcMain.handle('kiosk:setAutoStart', (_e, enabled) => {
    db.setSetting('autoStart', enabled ? '1' : '0')
    return kiosk.setAutoStart(enabled)
  })

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

  /**
   * Reprints a sale the register already recorded.
   *
   * Takes a uuid and nothing else. The ticket body is read back out of SQLite
   * here rather than accepted from the renderer, so a reprint is physically
   * incapable of showing a price, a total or a payment method that the sale
   * does not actually have on file — and the slip it produces is stamped COPIA
   * so it cannot be handed over as a second sale.
   */
  ipcMain.handle('sales:recent', (_e, limit) => db.listRecentSales(limit))

  ipcMain.handle('printer:reprint', async (_e, uuid) => {
    const sale = db.getSaleReceipt(uuid)
    if (!sale) return { ok: false, error: 'Esa venta ya no está en el registro' }

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
  ipcMain.handle('images:pick', async (event) => {
    // Parented to the calling window: while the register is locked it sits
    // always-on-top, and an ownerless dialog would open behind it.
    const parent = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(parent, {
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
