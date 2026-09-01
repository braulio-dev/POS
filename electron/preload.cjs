const { contextBridge, ipcRenderer } = require('electron')

// The renderer never touches Node or the database directly. Everything crosses
// this bridge, which keeps the attack surface to exactly the calls listed here.
contextBridge.exposeInMainWorld('pos', {
  listProducts: () => ipcRenderer.invoke('products:list'),
  findByBarcode: (barcode) => ipcRenderer.invoke('products:findByBarcode', barcode),
  findByScaleCode: (itemCode, prefix) =>
    ipcRenderer.invoke('products:findByScaleCode', itemCode, prefix),
  createProduct: (input) => ipcRenderer.invoke('products:create', input),
  updateProduct: (id, input) => ipcRenderer.invoke('products:update', id, input),
  deactivateProduct: (id) => ipcRenderer.invoke('products:deactivate', id),
  recordSale: (sale) => ipcRenderer.invoke('sales:record', sale),
  pickImage: () => ipcRenderer.invoke('images:pick'),

  listInventory: () => ipcRenderer.invoke('inventory:list'),
  setStock: (id, stock) => ipcRenderer.invoke('inventory:setStock', id, stock),
  setTrackStock: (id, tracked) => ipcRenderer.invoke('inventory:setTrackStock', id, tracked),
  setStockBulk: (entries) => ipcRenderer.invoke('inventory:setStockBulk', entries),

  getTerminalStatus: () => ipcRenderer.invoke('terminal:status'),
  terminalCharge: (input) => ipcRenderer.invoke('terminal:charge', input),
  terminalPoll: (intentId) => ipcRenderer.invoke('terminal:poll', intentId),
  terminalCancel: (intentId) => ipcRenderer.invoke('terminal:cancel', intentId),
  testTerminal: (config) => ipcRenderer.invoke('terminal:test', config),

  getCashDrawer: () => ipcRenderer.invoke('cash:drawer'),
  recordCorte: (options) => ipcRenderer.invoke('cash:corte', options ?? {}),
  listCortes: (limit) => ipcRenderer.invoke('cash:listCortes', limit ?? 20),
  listMovements: () => ipcRenderer.invoke('cash:movements'),
  recordMovement: (input) => ipcRenderer.invoke('cash:movement', input),

  listRecentSales: (limit) => ipcRenderer.invoke('sales:recent', limit ?? 30),
  reprintReceipt: (uuid) => ipcRenderer.invoke('printer:reprint', uuid),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  verifyPassword: (password) => ipcRenderer.invoke('settings:verifyPassword', password),
  setPassword: (current, next) => ipcRenderer.invoke('settings:setPassword', current, next),

  getKioskState: () => ipcRenderer.invoke('kiosk:state'),
  setKioskMode: (enabled) => ipcRenderer.invoke('kiosk:setMode', enabled),
  kioskUnlock: (password) => ipcRenderer.invoke('kiosk:unlock', password),
  kioskRelock: () => ipcRenderer.invoke('kiosk:relock'),
  kioskQuit: () => ipcRenderer.invoke('kiosk:quit'),
  setAutoStart: (enabled) => ipcRenderer.invoke('kiosk:setAutoStart', enabled),

  listPrinters: () => ipcRenderer.invoke('printer:list'),
  testPrinter: (printerName) => ipcRenderer.invoke('printer:test', printerName),
  printReceipt: (sale) => ipcRenderer.invoke('printer:receipt', sale),

  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  resendAll: () => ipcRenderer.invoke('sync:resendAll'),
  testSync: (config) => ipcRenderer.invoke('sync:test', config),
  getMaintenance: () => ipcRenderer.invoke('sync:maintenance'),
  runBackup: () => ipcRenderer.invoke('sync:backup'),

  /**
   * Push updates from the sync worker. Returns its own unsubscribe function —
   * handing back `ipcRenderer.off` directly would leak the raw module into the
   * renderer and defeat the point of the bridge.
   */
  onSyncStatus: (callback) => {
    const handler = (_event, status) => callback(status)
    ipcRenderer.on('sync:status', handler)
    return () => ipcRenderer.off('sync:status', handler)
  },
})
