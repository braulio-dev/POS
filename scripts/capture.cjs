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

// Header buttons are picked by their label rather than their position. They
// used to be indexed, which broke silently the first time a button was added
// to the left of Inventario: the harness kept passing while clicking the wrong
// thing, which is the one failure mode a screenshot test cannot show you.
const HEADER = `((label) => [...document.querySelectorAll('.icon-btn')]
  .find((b) => b.getAttribute('aria-label') === label))`

/** Types into a React-controlled input the way the real keyboard would. */
const TYPE = `((el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
})`

/**
 * capturePage occasionally rejects with UnknownVizError when Chromium's GPU
 * process is still coming up (or has just been restarted underneath us). It is
 * transient and unrelated to what is being screenshotted, so one retry after a
 * beat turns a dead run into a slightly slower one.
 */
async function shoot(win, name) {
  let img
  try {
    img = await win.capturePage()
  } catch (err) {
    console.log(`retrying capture of ${name} after ${err.message}`)
    await wait(1500)
    img = await win.capturePage()
  }
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
    // Frijol carries the item code its scale is programmed with, so the label
    // scanned further down resolves to it.
    ['Huevo Kg', 6400, null, 0, false], ['Frijol Kg', 3900, '01234', 0, false],
    ['Jabon Zote', 2600, null, -3, true],
  ]) {
    if (!REAL) db.createProduct({ barcode, name, priceCents: price, imageFile: null, stock, trackStock: tracked })
  }

  // A low corte threshold so one demo sale is enough to raise the banner.
  if (!REAL) db.setSetting('corteThresholdCents', '1000')
  // Scale labels are off on a real register until the owner says which way
  // their scale encodes them; the harness turns them on to exercise the path.
  if (!REAL) db.setSetting('scaleMode', 'weight')

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
  await win.webContents.executeJavaScript(`${HEADER}('Configuración').click()`)
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
  await win.webContents.executeJavaScript(`${HEADER}('Inventario').click()`)
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

  // 2. Add-product modal — now reached from inside Inventario, which is behind
  //    the password, rather than from a button on the sale screen.
  await win.webContents.executeJavaScript(`${HEADER}('Inventario').click()`)
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
  await win.webContents.executeJavaScript(`document.querySelector('.inventory-add').click()`)
  await wait(500)

  const addOpen = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.product-modal'))`
  )
  console.log(addOpen ? 'ADDPRODUCT PASS: reached from Inventario' : 'ADDPRODUCT FAIL')
  const noFab = await win.webContents.executeJavaScript(`document.querySelector('.fab') === null`)
  console.log(noFab ? 'ADDPRODUCT PASS: no + button left on the sale screen' : 'ADDPRODUCT FAIL: fab still present')

  await shoot(win, '2-add-product')

  // Dismissing the add dialog by its backdrop must not take Inventario with it.
  await win.webContents.executeJavaScript(`
    (() => {
      const backs = document.querySelectorAll('.modal-backdrop');
      backs[backs.length - 1].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    })()
  `)
  await wait(400)
  const survived = await win.webContents.executeJavaScript(`
    Boolean(document.querySelector('.inventory-modal')) && document.querySelector('.product-modal') === null
  `)
  console.log(survived
    ? 'ADDPRODUCT PASS: closing the add dialog leaves Inventario open'
    : 'ADDPRODUCT FAIL: backdrop click closed Inventario too')
  await wait(200)
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.inventory-modal button')].find(b => b.textContent.includes('Cerrar')).click()
  `)
  await wait(400)

  // The payment flow commits a real sale row (and would spool a real ticket),
  // so it only runs against the throwaway database.
  if (REAL) {
    console.log('REAL mode: skipping the sale flow so the store database stays clean')
    app.exit(0)
    return
  }

  // 3. Payment modal with a received amount typed in.
  await win.webContents.executeJavaScript(`document.querySelector('.ticket-actions .btn-cobrar').click()`)
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

  await win.webContents.executeJavaScript(`document.querySelector('.corte-banner .btn-corte').click()`)
  await wait(500)

  // The cut now asks who is handing the drawer over and what they counted, so
  // the harness fills both in. The counted figure is deliberately a few pesos
  // short of what the register expects, which is what puts the "faltan" verdict
  // into the screenshot — a cut that always balances never shows its own alarm.
  const expected = await win.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('.corte-summary > div')];
      const row = rows.find((r) => r.textContent.includes('DEBE HABER'));
      return row ? row.querySelector('dd').textContent : null;
    })()
  `)
  console.log('CORTE expected in drawer:', expected)

  await win.webContents.executeJavaScript(`
    (() => {
      const type = ${TYPE};
      const fields = [...document.querySelectorAll('.product-modal input')];
      type(document.querySelector('.corte-field input'), 'Lupe');
      const counted = fields.find((f) => f.placeholder === '0.00');
      type(counted, '95');
    })()
  `)
  await wait(400)
  await shoot(win, '9-corte-modal')

  const verdict = await win.webContents.executeJavaScript(`
    (() => {
      const v = document.querySelector('.corte-verdict');
      return v ? v.textContent : null;
    })()
  `)
  console.log(verdict ? `CORTE PASS: verdict shown — ${JSON.stringify(verdict)}` : 'CORTE FAIL: no verdict')

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

  // --- Granel: a product with no Inventario is priced by the kilo ---------
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.product-card')].find((c) => c.textContent.includes('Frijol')).click()
  `)
  await wait(500)
  const weighOpen = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.weight-modal'))`
  )
  console.log(weighOpen
    ? 'GRANEL PASS: an untracked product opens the scale screen instead of adding one piece'
    : 'GRANEL FAIL: no weight screen')

  await win.webContents.executeJavaScript(
    `${TYPE}(document.querySelector('.weight-input'), '1.35')`
  )
  await wait(400)
  await shoot(win, '11-weight')

  const priced = await win.webContents.executeJavaScript(
    `document.querySelector('.weight-result-total').textContent`
  )
  // 1.350 kg of a $39.00 kilo is $52.65, rounded once, here.
  console.log(priced === '$52.65'
    ? `GRANEL PASS: 1.350 kg priced at ${priced}`
    : `GRANEL FAIL: priced at ${priced}`)

  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.weight-modal button')].find((b) => b.textContent.includes('AGREGAR')).click()
  `)
  await wait(500)
  const weighedLine = await win.webContents.executeJavaScript(`
    (() => {
      const row = [...document.querySelectorAll('.cart-row')].find((r) => r.textContent.includes('Frijol'));
      return row ? row.textContent : null;
    })()
  `)
  console.log(weighedLine && weighedLine.includes('1.350 kg')
    ? `GRANEL PASS: cart line reads ${JSON.stringify(weighedLine)}`
    : `GRANEL FAIL: cart line ${JSON.stringify(weighedLine)}`)

  // --- A label printed by the deli scale ----------------------------------
  // 20 | 01234 | 01350 | 8  ->  item 01234, 1350 g. Nothing is typed: the scale
  // already weighed it, and the register is being handed that fact.
  for (const ch of '2001234013508') { sendChar(ch); await wait(6) }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(700)

  const scaleLines = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.cart-row')].map((r) => r.textContent)
  `)
  const weighedByLabel = scaleLines.filter((t) => t.includes('Frijol')).length
  console.log(weighedByLabel === 2
    ? `BASCULA PASS: label rang itself up — ${JSON.stringify(scaleLines.at(-1))}`
    : `BASCULA FAIL: ${JSON.stringify(scaleLines)}`)
  await shoot(win, '14-scale-label')

  // --- Cash in and out ----------------------------------------------------
  await win.webContents.executeJavaScript(`${HEADER}('Entradas y salidas').click()`)
  await wait(500)
  await win.webContents.executeJavaScript(`
    (() => {
      const type = ${TYPE};
      const inputs = [...document.querySelectorAll('.cash-modal input')];
      type(inputs.find((i) => i.placeholder === '0.00'), '180');
      type(inputs.find((i) => i.maxLength === 80), 'Pago de tortillas');
    })()
  `)
  await wait(300)
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.cash-modal button')].find((b) => b.textContent.includes('REGISTRAR SALIDA')).click()
  `)
  await wait(700)
  await shoot(win, '12-cash-movements')

  const movement = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('.movement-row');
      return row ? row.textContent : null;
    })()
  `)
  console.log(movement && movement.includes('180')
    ? `CAJA PASS: salida recorded — ${JSON.stringify(movement)}`
    : `CAJA FAIL: ${JSON.stringify(movement)}`)

  // The drawer must now expect 180 pesos less than the sales alone would say.
  const expectedAfter = await win.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('.cash-modal .corte-summary > div')];
      const row = rows.find((r) => r.textContent.includes('DEBE HABER'));
      return row ? row.querySelector('dd').textContent : null;
    })()
  `)
  console.log('CAJA expected after salida:', expectedAfter)

  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.cash-modal button')].find((b) => b.textContent.includes('Cerrar')).click()
  `)
  await wait(400)

  // --- Reprinting a ticket ------------------------------------------------
  await win.webContents.executeJavaScript(`${HEADER}('Tickets').click()`)
  await wait(600)
  await shoot(win, '13-tickets')

  const tickets = await win.webContents.executeJavaScript(
    `document.querySelectorAll('.ticket-card').length`
  )
  console.log(tickets > 0
    ? `TICKETS PASS: ${tickets} venta(s) disponible(s) para reimprimir`
    : 'TICKETS FAIL: no sales listed')

  app.exit(0)
})
