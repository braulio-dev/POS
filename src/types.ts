import type { PaymentMethod, TerminalDetails, TerminalStatus } from './lib/tender'

export type { PaymentMethod, TerminalDetails, TerminalStatus }

export interface Product {
  id: number
  uuid: string
  barcode: string | null
  name: string
  price_cents: number
  image_file: string | null
  stock: number
  /** 0 for goods sold loose (by weight/bag), which have no unit count. */
  track_stock: number
  updated_at: string | null
  stock_updated_at: string | null
}

export interface CartLine {
  productId: number | null
  name: string
  unitPriceCents: number
  qty: number
}

export interface NewProductInput {
  barcode: string | null
  name: string
  priceCents: number
  imageFile: string | null
  stock?: number
  trackStock?: boolean
}

export interface SaleInput {
  items: CartLine[]
  totalCents: number
  /** Cash handed over. 0 on a pure card sale. */
  receivedCents: number
  changeCents: number

  /**
   * The payment split. `cashCents + cardCents` must equal `totalCents` — the
   * main process re-derives it and re-labels the method, so these are a claim
   * the register checks rather than a fact it takes on trust.
   */
  paymentMethod: PaymentMethod
  cashCents: number
  cardCents: number
  terminal: TerminalDetails | null
}

export interface Settings {
  printerName: string
  autoPrint: string
  storeName: string

  /** Cash in the drawer, in cents, that triggers the corte reminder. 0 disables it. */
  corteThresholdCents: string
  /** At or below this many units a product is flagged as running out. */
  lowStockThreshold: string

  /** '1' while the card terminal is offered on the payment screen. */
  terminalEnabled: string
  /** 'manual' (cashier types the auth code) | 'clip' | 'mercadopago'. */
  terminalProvider: string
  /** '1' to push the amount to the terminal over its API instead of its keypad. */
  terminalAutoCharge: string
  terminalApiUrl: string
  terminalApiKey: string
  terminalDeviceId: string

  syncEnabled: string
  syncUrl: string
  syncKey: string
  syncStoreId: string
  syncIntervalSec: string
}

/** Money taken since the last corte, split by where it physically went. */
export interface CashDrawer {
  /** Everything sold in the period, cash and card together. */
  totalCents: number
  /** In the drawer right now. This is what the corte hands over. */
  cashCents: number
  /** Went through the terminal and never touched the drawer. */
  cardCents: number
  saleCount: number
  /** How many of those sales had a card leg. */
  cardSaleCount: number
  openedAt: string
  thresholdCents: number
  /** Measured against cash only — card takings are not a drawer risk. */
  needsCorte: boolean
}

export interface Corte {
  uuid: string
  createdAt: string
  openedAt: string
  totalCents: number
  cashCents: number
  cardCents: number
  saleCount: number
  /** Who was on the till, as typed at the corte. Null on cuts taken before the field existed. */
  cashier: string | null
}

export interface CorteRow {
  uuid: string
  total_cents: number
  cash_cents: number
  card_cents: number
  sale_count: number
  cashier: string | null
  opened_at: string
  created_at: string
}

/** What a driver reports back about a charge in flight. */
export interface TerminalChargeResult {
  ok: boolean
  provider?: string
  intentId?: string | null
  status?: TerminalStatus
  final?: boolean
  reference?: string | null
  cardBrand?: string | null
  cardLast4?: string | null
  /** Set when the charge could not be started: the screen falls back to manual. */
  fallback?: 'manual'
  reason?: string
}

export interface TerminalState {
  provider: string
  /** Whether a card sale can be taken at all. Manual capture is always ready. */
  ready: boolean
  /** True when the amount is pushed to the terminal rather than typed on it. */
  autoCharge: boolean
  configured: boolean
}

export interface SyncStatus {
  enabled: boolean
  configured: boolean
  /** Outbox rows still waiting to reach the server. */
  pending: number
  lastSyncAt: string | null
  lastError: string | null
  cursor: string | null
  running: boolean
}

export interface BackupFile {
  name: string
  bytes: number
  createdAt: string
}

export interface MaintenanceStatus {
  backupEnabled: boolean
  backupIntervalMs: number
  backupKeep: number
  lastBackupAt: string | null
  lastBackupError: string | null
  purgeEnabled: boolean
  purgeDays: number
  changesDays: number
  lastPurgeAt: string | null
  lastPurgeError: string | null
  backups: BackupFile[]
  databaseBytes: number
}

export interface PrintResult {
  ok: boolean
  error?: string
}

export interface PasswordResult {
  ok: boolean
  error?: string
}

export interface ReceiptInput extends SaleInput {
  folio: string
  createdAt: string
}

export interface StockEntry {
  id: number
  stock: number
}

export interface PosApi {
  listProducts(): Promise<Product[]>
  findByBarcode(barcode: string): Promise<Product | null>
  createProduct(input: NewProductInput): Promise<Product>
  updateProduct(id: number, input: NewProductInput): Promise<Product>
  deactivateProduct(id: number): Promise<void>
  recordSale(sale: SaleInput): Promise<{ id: number; uuid: string; createdAt: string }>
  pickImage(): Promise<string | null>

  listInventory(): Promise<Product[]>
  setStock(id: number, stock: number): Promise<Product>
  setTrackStock(id: number, tracked: boolean): Promise<Product>
  setStockBulk(entries: StockEntry[]): Promise<Product[]>

  /* --------------------------------------------------------- card terminal */

  getTerminalStatus(): Promise<TerminalState>
  /** Starts a charge. `ok: false, fallback: 'manual'` means type the code by hand. */
  terminalCharge(input: { amountCents: number; reference: string }): Promise<TerminalChargeResult>
  terminalPoll(intentId: string): Promise<TerminalChargeResult>
  terminalCancel(intentId: string): Promise<{ ok: boolean; status: string; reason?: string }>
  testTerminal(config: {
    provider: string; apiUrl: string; apiKey: string; deviceId: string
  }): Promise<{ ok: boolean; error?: string; note?: string }>

  getCashDrawer(): Promise<CashDrawer>
  recordCorte(options?: { print?: boolean; cashier?: string | null }): Promise<{ corte: Corte; printed: PrintResult }>
  listCortes(limit?: number): Promise<CorteRow[]>

  getSettings(): Promise<Settings>
  setSetting(key: keyof Settings, value: string): Promise<Settings>
  /** Answers yes/no only — the hash never leaves the main process. */
  verifyPassword(password: string): Promise<boolean>
  setPassword(current: string, next: string): Promise<PasswordResult>

  listPrinters(): Promise<string[]>
  testPrinter(printerName: string): Promise<PrintResult>
  printReceipt(sale: ReceiptInput): Promise<PrintResult>

  /** Server-side maintenance state, fetched over the sync connection. */
  getMaintenance(): Promise<{ ok: boolean; error?: string; status?: MaintenanceStatus }>
  runBackup(): Promise<{ ok: boolean; error?: string; backup?: BackupFile }>

  getSyncStatus(): Promise<SyncStatus>
  syncNow(): Promise<{ ok: boolean; error?: string; pushed?: number; applied?: number; uploaded?: number; downloaded?: number }>
  /** Re-queues the whole catalogue and history, then syncs. */
  resendAll(): Promise<{
    ok: boolean; error?: string; pushed?: number; applied?: number
    queued?: { products: number; stock: number; sales: number; cortes: number }
  }>
  testSync(config: { url: string; key: string; storeId: string }): Promise<{ ok: boolean; error?: string; server?: string }>
  /** Subscribes to worker updates; returns its own unsubscribe function. */
  onSyncStatus(callback: (status: SyncStatus) => void): () => void
}

declare global {
  interface Window {
    pos: PosApi
  }
}
