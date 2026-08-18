/**
 * Dev utility: boot the register against the Vite dev server, drive it a little,
 * and save PNGs. Lets us eyeball the real Electron rendering (custom protocol,
 * fonts, kiosk sizing) without standing in front of the machine.
 *
 *   npx electron scripts/capture.cjs <outDir>
 */
const { app, BrowserWindow, protocol, net } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const db = require('../electron/db.cjs')
const { registerIpc } = require('../electron/ipc.cjs')

const OUT = process.argv[2] || path.join(__dirname, '..', '.captures')

// --real screenshots the actual store database (seeded products, real photos).
// Without it we use a throwaway database with known barcodes, which is what the
// scanner assertions need to be deterministic.
const REAL = process.argv.includes('--real')
if (REAL) app.setName('pos-elpaisa')
const DATA_DIR = REAL ? app.getPath('userData') : path.join(app.getPath('temp'), 'pos-capture')
const IMAGE_DIR = path.join(DATA_DIR, 'images')

protocol.registerSchemesAsPrivileged([
  { scheme: 'posimg', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function shoot(win, name) {
  const img = await win.capturePage()
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG())
  console.log('saved', name)
}

app.whenReady().then(async () => {
  if (!REAL) fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })
  db.openDatabase(DATA_DIR)

  protocol.handle('posimg', (req) =>
    net.fetch(pathToFileURL(path.join(IMAGE_DIR, path.basename(new URL(req.url).pathname))).toString())
  )

  // Stock values are seeded across the three bands (healthy / low / out) so the
  // screenshots actually exercise the badge styling rather than one colour.
  // Stock spans every band (healthy / low / out / oversold) and includes goods
  // sold loose, so the screenshots exercise the badge styling rather than one
  // colour, and prove untracked items stay quiet.
  for (const [name, price, barcode, stock, tracked] of [
    ['Papas', 5600, null, 14, true], ['Tortillas', 3000, null, 2, true],
    ['Cereal', 7000, null, 0, true], ['Coca 600ml', 2200, '7501055300150', 24, true],
    ['Pan Bimbo', 4500, null, 6, true], ['Leche 1L', 2800, null, 1, true],
    ['Huevo Kg', 6400, null, 0, false], ['Frijol Kg', 3900, null, 0, false],
    ['Jabon Zote', 2600, null, -3, true],
  ]) {
    if (!REAL) db.createProduct({ barcode, name, priceCents: price, imageFile: null, stock, trackStock: tracked })
  }

  // A low corte threshold so one demo sale is enough to raise the banner.
  if (!REAL) db.setSetting('corteThresholdCents', '1000')

  registerIpc({ imageDir: IMAGE_DIR })

  const win = new BrowserWindow({
    width: 1280, height: 800, show: true, backgroundColor: '#EDE0AC',
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true },
  })
  await win.loadURL('http://localhost:5173')
  await wait(1200)

  // 1. Main screen with a cart built up.
  await win.webContents.executeJavaScript(`
    (() => {
      const cards = [...document.querySelectorAll('.product-card')];
      ['Papas','Tortillas','Cereal'].forEach(n => {
        const c = cards.find(c => c.textContent.includes(n));
        c && c.click();
      });
    })()
  `)
  await wait(400)
  await shoot(win, '1-main')

  // --- Scanner simulation -------------------------------------------------
  // sendInputEvent injects real keystrokes at the browser level, so the
  // characters genuinely land in whatever has focus. That means this exercises
  // the same leak-into-the-search-box path the physical Datalogic would.
  function sendChar(ch) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
  }

  await win.webContents.executeJavaScript(`document.querySelector('.search-input').focus()`)
  await wait(200)
  for (const ch of '7501055300150') { sendChar(ch); await wait(6) }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(500)

  const scan = await win.webContents.executeJavaScript(`
    ({
      cart: [...document.querySelectorAll('.cart-row')].map(r => r.textContent),
      search: document.querySelector('.search-input').value,
    })
  `)
  console.log('SCAN cart      :', JSON.stringify(scan.cart))
  console.log('SCAN searchbox :', JSON.stringify(scan.search))
  // Only meaningful against the throwaway database, which seeds a known
  // barcode. The real store products have no barcodes registered yet.
  if (REAL) {
    console.log(`SCAN n/a (real db): search box left ${scan.search === '' ? 'clean' : 'dirty'}`)
  } else {
    console.log(
      scan.cart.some((t) => t.includes('Coca')) && scan.search === ''
        ? 'SCAN PASS: item added, search box left clean'
        : 'SCAN FAIL'
    )
  }
  await shoot(win, '5-after-scan')

  // Typing at human speed must NOT be treated as a scan.
  await win.webContents.executeJavaScript(`document.querySelector('.search-input').focus()`)
  for (const ch of 'pap') { sendChar(ch); await wait(140) }
  await wait(300)
  const typed = await win.webContents.executeJavaScript(
    `document.querySelector('.search-input').value`
  )
  console.log(typed === 'pap' ? 'TYPING PASS: slow keys stayed in the box' : `TYPING FAIL: ${typed}`)
  await win.webContents.executeJavaScript(`
    (() => {
      const i = document.querySelector('.search-input');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      s.call(i, ''); i.dispatchEvent(new Event('input',{bubbles:true})); i.blur();
    })()
  `)
  await wait(300)

  // 2b. Configuración now sits behind the password gate.
  await win.webContents.executeJavaScript(`document.querySelector('.icon-btn').click()`)
  await wait(500)
  await shoot(win, '6a-password')

  await win.webContents.executeJavaScript(`
    (() => {
      const i = document.querySelector('.password-modal input[type=password]');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      s.call(i, '1234'); i.dispatchEvent(new Event('input',{bubbles:true}));
    })()
  `)
  await wait(200)
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.password-modal button')].find(b => b.textContent.includes('ENTRAR')).click()
  `)
  await wait(800)

  const unlocked = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.settings-modal'))`
  )
  console.log(unlocked ? 'PASSWORD PASS: 1234 opened Configuración' : 'PASSWORD FAIL')
  await shoot(win, '6b-settings')

  // Each settings tab, so a layout regression in any of them is visible.
  for (const [label, name] of [['Corte', '6c-settings-corte'], ['Sincronización', '6d-settings-sync'], ['Respaldos', '6e-settings-backups']]) {
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('.settings-tab')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()
    `)
    await wait(400)
    await shoot(win, name)
  }
  await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  await wait(300)

  // 2c. Inventory, behind the same gate.
  await win.webContents.executeJavaScript(`document.querySelector('.icon-btn-right').click()`)
  await wait(400)
  await win.webContents.executeJavaScript(`
    (() => {
      const i = document.querySelector('.password-modal input[type=password]');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      s.call(i, '1234'); i.dispatchEvent(new Event('input',{bubbles:true}));
      [...document.querySelectorAll('.password-modal button')].find(b => b.textContent.includes('ENTRAR')).click();
    })()
  `)
  await wait(800)
  // Retype one quantity so the dirty-row highlight is in the screenshot.
  await win.webContents.executeJavaScript(`
    (() => {
      const i = document.querySelectorAll('.qty-input')[1];
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      s.call(i, '18'); i.dispatchEvent(new Event('input',{bubbles:true}));
    })()
  `)
  await wait(300)
  await shoot(win, '7-inventory')
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.inventory-modal button')].find(b => b.textContent.includes('Cerrar')).click()
  `)
  await wait(400)

  // 2. Add-product modal.
  await win.webContents.executeJavaScript(`document.querySelector('.fab').click()`)
  await wait(400)
  await shoot(win, '2-add-product')
  await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  await wait(300)

  // The payment flow commits a real sale row (and would spool a real ticket),
  // so it only runs against the throwaway database.
  if (REAL) {
    console.log('REAL mode: skipping the sale flow so the store database stays clean')
    app.exit(0)
    return
  }

  // 3. Payment modal with a received amount typed in.
  await win.webContents.executeJavaScript(`document.querySelector('.footer-action button').click()`)
  await wait(400)
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('recibido');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '200');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `)
  await wait(300)
  await shoot(win, '3-payment')

  // 4. Change screen.
  await win.webContents.executeJavaScript(`document.querySelector('.payment-cobrar').click()`)
  await wait(600)
  await shoot(win, '4-change')

  // 5. Dismissing it drops back to the sale screen, where the sale just made
  //    has pushed the drawer past the threshold seeded above.
  await win.webContents.executeJavaScript(`document.querySelector('.change-screen').click()`)
  await wait(700)

  const banner = await win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('.corte-banner');
      return b ? b.textContent : null;
    })()
  `)
  console.log(banner ? `CORTE PASS: banner shown — ${JSON.stringify(banner)}` : 'CORTE FAIL: no banner')
  await shoot(win, '8-corte-banner')

  await win.webContents.executeJavaScript(`document.querySelector('.btn-corte').click()`)
  await wait(500)
  await shoot(win, '9-corte-modal')

  // Confirming must zero the drawer and take the banner away.
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.product-modal button')].find(b => b.textContent.includes('CONFIRMAR')).click()
  `)
  await wait(1200)
  const cleared = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.corte-banner')) === false`
  )
  console.log(cleared ? 'CORTE PASS: banner cleared after the cut' : 'CORTE FAIL: banner still up')
  await shoot(win, '10-after-corte')

  app.exit(0)
})
