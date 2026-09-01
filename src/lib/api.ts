import type {
  CashMovement, CorteRow, MovementInput, NewProductInput, PosApi, Product,
  SaleRecord, Settings, StockEntry, SyncStatus,
} from '../types'

/**
 * In Electron, `window.pos` is injected by the preload bridge and every call
 * hits real SQLite. Opening the Vite dev server in a plain browser has no such
 * bridge, so we fall back to an in-memory stand-in. That makes UI work fast to
 * iterate on — but nothing persists, which is exactly what you want for a
 * scratch layout pass and never what you want at the counter.
 */
function createBrowserMock(): PosApi {
  let nextId = 5
  const stamp = new Date().toISOString()

  const product = (
    id: number, barcode: string | null, name: string, price: number,
    stock: number, trackStock = 1
  ): Product => ({
    id,
    uuid: `mock-${id}`,
    barcode,
    name,
    price_cents: price,
    image_file: null,
    stock,
    track_stock: trackStock,
    updated_at: stamp,
    stock_updated_at: stamp,
  })

  const products: Product[] = [
    product(1, '7501000111', 'Papas', 5600, 12),
    product(2, '7501000222', 'Tortillas', 3000, 2),
    product(3, '7501000333', 'Cereal', 7000, 0),
    // Registered with the item code its scale prints, so a label like
    // 20 01234 01350 C resolves here.
    product(4, '01234', 'Frijol Kg', 3900, 0, 0),
  ]

  const settings: Settings = {
    printerName: 'POS58 Printer',
    autoPrint: '1',
    storeName: 'Abarrotes "El Paisa"',
    corteThresholdCents: '200000',
    lowStockThreshold: '3',
    cashFloatCents: '0',
    kioskMode: '0',
    autoStart: '0',
    // On in the stand-in, unlike the real register: a browser has no scanner,
    // so the only way to exercise a scale label here is to call findByScaleCode
    // from the console, and having it disabled would just look broken.
    scaleMode: 'weight',
    terminalEnabled: '1',
    terminalProvider: 'manual',
    terminalAutoCharge: '0',
    terminalApiUrl: '',
    terminalApiKey: '',
    terminalDeviceId: '',
    syncEnabled: '0',
    syncUrl: '',
    syncKey: '',
    syncStoreId: 'principal',
    syncIntervalSec: '60',
  }

  // The mock drawer accumulates so the corte banner can actually be seen in a
  // browser without ringing up two thousand pesos of real sales. It carries the
  // same cash/card split as the real one, so a layout pass can actually see
  // what a mixed period looks like instead of only the all-cash case.
  let drawerCents = 0
  let drawerCashCents = 0
  let drawerCardCents = 0
  let drawerSales = 0
  let drawerCardSales = 0
  let openedAt = stamp
  let floatCents = 0
  const cortes: CorteRow[] = []
  const movements: CashMovement[] = []
  const sales: SaleRecord[] = []

  const syncStatus: SyncStatus = {
    enabled: false, configured: false, pending: 0,
    lastSyncAt: null, lastError: null, cursor: null, running: false,
  }

  return {
    async listProducts() { return [...products] },
    async findByBarcode(barcode) { return products.find((p) => p.barcode === barcode) ?? null },
    async findByScaleCode(itemCode, prefix) {
      return products.find((p) => p.barcode === itemCode || p.barcode === prefix) ?? null
    },
    async createProduct(input: NewProductInput) {
      const created = product(
        nextId, input.barcode, input.name, input.priceCents,
        input.stock ?? 0, input.trackStock === false ? 0 : 1
      )
      created.image_file = input.imageFile
      nextId++
      products.push(created)
      return created
    },
    async updateProduct(id, input) {
      const i = products.findIndex((p) => p.id === id)
      products[i] = { ...products[i], name: input.name, price_cents: input.priceCents }
      return products[i]
    },
    async deactivateProduct(id) {
      const i = products.findIndex((p) => p.id === id)
      if (i >= 0) products.splice(i, 1)
    },
    async recordSale(sale) {
      for (const item of sale.items) {
        const p = products.find((x) => x.id === item.productId)
        // Weight lines never move a count, exactly like the real one.
        if (p && p.track_stock && item.unit !== 'kg') p.stock -= item.qty
      }
      drawerCents += sale.totalCents
      drawerCashCents += sale.cashCents ?? sale.totalCents
      drawerCardCents += sale.cardCents ?? 0
      drawerSales += 1
      if ((sale.cardCents ?? 0) > 0) drawerCardSales += 1

      const record: SaleRecord = {
        uuid: `mock-sale-${sales.length + 1}`,
        createdAt: new Date().toISOString(),
        totalCents: sale.totalCents,
        receivedCents: sale.receivedCents,
        changeCents: sale.changeCents,
        paymentMethod: sale.paymentMethod,
        cashCents: sale.cashCents,
        cardCents: sale.cardCents,
        items: sale.items,
      }
      sales.unshift(record)
      return { id: sales.length, uuid: record.uuid, createdAt: record.createdAt }
    },

    async listRecentSales(limit = 30) { return sales.slice(0, limit) },
    async reprintReceipt() { return { ok: false, error: 'Sin impresora en el navegador' } },
    async pickImage() { return null },

    async listInventory() { return [...products] },
    async setStock(id, stock) {
      const p = products.find((x) => x.id === id)!
      p.stock = Math.trunc(stock)
      return p
    },
    async setTrackStock(id, tracked) {
      const p = products.find((x) => x.id === id)!
      p.track_stock = tracked ? 1 : 0
      return p
    },
    async setStockBulk(entries: StockEntry[]) {
      for (const e of entries) {
        const p = products.find((x) => x.id === e.id)
        if (p) p.stock = Math.trunc(e.stock)
      }
      return [...products]
    },

    async getCashDrawer() {
      const thresholdCents = Number(settings.corteThresholdCents) || 0
      const cashInCents = movements.filter((m) => m.kind === 'in')
        .reduce((sum, m) => sum + m.amountCents, 0)
      const cashOutCents = movements.filter((m) => m.kind === 'out')
        .reduce((sum, m) => sum + m.amountCents, 0)

      return {
        totalCents: drawerCents,
        cashCents: drawerCashCents,
        cardCents: drawerCardCents,
        saleCount: drawerSales,
        cardSaleCount: drawerCardSales,
        openedAt,
        thresholdCents,
        // Cash only, exactly like the real one in electron/db.cjs.
        needsCorte: thresholdCents > 0 && drawerCashCents >= thresholdCents,
        floatCents,
        cashInCents,
        cashOutCents,
        movementCount: movements.length,
        expectedCents: floatCents + drawerCashCents + cashInCents - cashOutCents,
      }
    },

    async listMovements() { return [...movements] },
    async recordMovement(input: MovementInput) {
      const movement: CashMovement = {
        uuid: `mock-mov-${movements.length + 1}`,
        kind: input.kind,
        amountCents: Math.abs(Math.trunc(input.amountCents)),
        reason: input.reason,
        person: input.person ?? null,
        createdAt: new Date().toISOString(),
      }
      movements.unshift(movement)
      return movement
    },

    async recordCorte(options) {
      const cashier = String(options?.cashier ?? '').trim() || null
      const drawer = await this.getCashDrawer()
      const counted = options?.countedCents ?? null
      const inDrawer = counted ?? drawer.expectedCents
      const floatLeft = Math.min(Math.max(0, options?.floatLeftCents ?? 0), Math.max(0, inDrawer))

      const corte = {
        uuid: `mock-corte-${cortes.length + 1}`,
        createdAt: new Date().toISOString(),
        openedAt,
        totalCents: drawerCents,
        cashCents: drawerCashCents,
        cardCents: drawerCardCents,
        saleCount: drawerSales,
        cashier,
        floatStartCents: drawer.floatCents,
        cashInCents: drawer.cashInCents,
        cashOutCents: drawer.cashOutCents,
        expectedCents: drawer.expectedCents,
        countedCents: counted,
        floatLeftCents: floatLeft,
        deliveredCents: Math.max(0, inDrawer - floatLeft),
        differenceCents: counted === null ? null : counted - drawer.expectedCents,
      }
      cortes.unshift({
        uuid: corte.uuid, total_cents: corte.totalCents,
        cash_cents: corte.cashCents, card_cents: corte.cardCents,
        sale_count: corte.saleCount,
        cashier, opened_at: corte.openedAt, created_at: corte.createdAt,
        float_start_cents: corte.floatStartCents,
        cash_in_cents: corte.cashInCents,
        cash_out_cents: corte.cashOutCents,
        expected_cents: corte.expectedCents,
        counted_cents: corte.countedCents,
        float_left_cents: corte.floatLeftCents,
        difference_cents: corte.differenceCents,
      })
      drawerCents = 0
      drawerCashCents = 0
      drawerCardCents = 0
      drawerSales = 0
      drawerCardSales = 0
      movements.length = 0
      // The next period starts with whatever this cut left behind, exactly like
      // the chain of cortes in electron/db.cjs.
      floatCents = floatLeft
      openedAt = corte.createdAt
      return { corte, printed: { ok: false, error: 'Sin impresora en el navegador' } }
    },
    async listCortes() { return [...cortes] },

    /**
     * The stand-in terminal is always in manual mode, which is the honest
     * answer: there is no card reader attached to a browser tab. The payment
     * screen therefore shows its manual capture fields, so the card and mixed
     * layouts can be worked on without an Electron build or a real Clip.
     */
    async getTerminalStatus() {
      return { provider: 'manual', ready: true, autoCharge: false, configured: false }
    },
    async terminalCharge() {
      return { ok: false, fallback: 'manual' as const, reason: 'Sin terminal en el navegador' }
    },
    async terminalPoll() {
      return { ok: false, status: 'pending' as const, final: false, reason: 'Sin terminal en el navegador' }
    },
    async terminalCancel() { return { ok: true, status: 'canceled' } },
    async testTerminal() { return { ok: true, note: 'Captura manual: no necesita conexión' } },

    async getSettings() { return { ...settings } },
    async setSetting(key, value) {
      settings[key] = value
      return { ...settings }
    },
    // The browser stand-in accepts the shipped default so the settings screen
    // is reachable during layout work.
    async verifyPassword(password) { return password === '1234' },
    async setPassword() { return { ok: false, error: 'Sin base de datos en el navegador' } },

    // A browser tab has no kiosk to lock, so the stand-in reports itself open
    // and the exit flow stays reachable during layout work.
    async getKioskState() { return { locked: false, kioskMode: false, autoStart: false } },
    async setKioskMode() { return { ok: false } },
    async kioskUnlock() { return { ok: true } },
    async kioskRelock() { return { ok: true } },
    async kioskQuit() { return { ok: false, error: 'Sin ventana en el navegador' } },
    async setAutoStart() { return { ok: false, error: 'Solo en Windows' } },

    async listPrinters() { return ['POS58 Printer'] },
    async testPrinter() { return { ok: false, error: 'Sin impresora en el navegador' } },
    async printReceipt() { return { ok: false, error: 'Sin impresora en el navegador' } },

    async getMaintenance() { return { ok: false, error: 'Sin servidor en el navegador' } },
    async runBackup() { return { ok: false, error: 'Sin servidor en el navegador' } },

    async getSyncStatus() { return { ...syncStatus } },
    async syncNow() { return { ok: false, error: 'Sin sincronización en el navegador' } },
    async resendAll() { return { ok: false, error: 'Sin sincronización en el navegador' } },
    async testSync() { return { ok: false, error: 'Sin sincronización en el navegador' } },
    onSyncStatus() { return () => {} },
  }
}

export const pos: PosApi = window.pos ?? createBrowserMock()
export const isElectron = Boolean(window.pos)
