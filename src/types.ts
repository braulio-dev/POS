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
  receivedCents: number
  changeCents: number
}

export interface Settings {
  printerName: string
  autoPrint: string
  storeName: string

  /** Cash in the drawer, in cents, that triggers the corte reminder. 0 disables it. */
  corteThresholdCents: string
  /** At or below this many units a product is flagged as running out. */
  lowStockThreshold: string

  syncEnabled: string
  syncUrl: string
  syncKey: string
  syncStoreId: string
  syncIntervalSec: string
}

/** Cash taken since the last corte. */
export interface CashDrawer {
  totalCents: number
  saleCount: number
  openedAt: string
  thresholdCents: number
  needsCorte: boolean
}

export interface Corte {
  uuid: string
  createdAt: string
  openedAt: string
  totalCents: number
  saleCount: number
}

export interface CorteRow {
  uuid: string
  total_cents: number
  sale_count: number
  opened_at: string
  created_at: string
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

  getCashDrawer(): Promise<CashDrawer>
  recordCorte(options?: { print?: boolean }): Promise<{ corte: Corte; printed: PrintResult }>
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
