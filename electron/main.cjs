const { app, BrowserWindow, protocol, net } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const db = require('./db.cjs')
const sync = require('./sync.cjs')
const { registerIpc } = require('./ipc.cjs')

const IS_DEV = process.env.POS_DEV === '1'
const DATA_DIR = app.getPath('userData')
const IMAGE_DIR = path.join(DATA_DIR, 'images')

// Product images live outside the app bundle (they're user data), so they need a
// scheme the renderer can load. A custom protocol beats enabling file:// access.
protocol.registerSchemesAsPrivileged([
  { scheme: 'posimg', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#EDE0AC',
    autoHideMenuBar: true,
    // In production the register runs fullscreen with no chrome to escape into.
    fullscreen: !IS_DEV,
    kiosk: !IS_DEV,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  if (IS_DEV) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  return win
}

app.whenReady().then(() => {
  db.openDatabase(DATA_DIR)
  fs.mkdirSync(IMAGE_DIR, { recursive: true })

  protocol.handle('posimg', (request) => {
    const name = path.basename(decodeURIComponent(new URL(request.url).pathname))
    return net.fetch(pathToFileURL(path.join(IMAGE_DIR, name)).toString())
  })

  registerIpc({ imageDir: IMAGE_DIR })
  const win = createWindow()

  // The sync worker runs in the main process, not the renderer: it has to keep
  // draining the outbox while the cashier is mid-sale, and it must not die when
  // a window reloads. Status is pushed out so the settings screen can show it
  // live instead of polling.
  sync.start({
    imageDir: IMAGE_DIR,
    notify: (status) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('sync:status', status)
      }
    },
  })
  void win

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => sync.stop())
app.on('window-all-closed', () => app.quit())
