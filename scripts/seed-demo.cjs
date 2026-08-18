/**
 * Fills the register with demo stock so the grid isn't empty while you work on
 * it. Photos come from Wikimedia via the Wikipedia REST summary endpoint.
 *
 *   npx electron scripts/seed-demo.cjs [--reset]
 *
 * Runs under Electron purely so app.getPath('userData') resolves to the same
 * folder the real app uses — seeding a different database would be useless.
 *
 * NOTE: these images are Wikimedia content under CC licences. Fine as
 * placeholders; replace them with photos of the actual shelf before the store
 * runs on this.
 */
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const db = require('../electron/db.cjs')

// Wikimedia asks for a descriptive User-Agent and will refuse generic ones.
const UA = 'AbarrotesElPaisaPOS/0.1 (local store point-of-sale; demo seeding)'

// `electron <script>` can't infer the app name from package.json the way
// `electron .` does, so userData would land in %APPDATA%\Electron and we'd
// cheerfully seed a database the real app never opens. Pin it.
app.setName('pos-elpaisa')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Wikimedia returns 429 when hit in a tight loop. Back off and retry rather
 * than dropping the photo — the whole point of the script is the photos.
 */
async function getWithRetry(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) return res
    if (res.status !== 429) throw new Error(String(res.status))
    await sleep(1200 * (i + 1))
  }
  throw new Error('429 tras varios intentos')
}

// [display name, price in cents, Spanish Wikipedia article to take a photo from]
const DEMO = [
  ['Papas', 5600, 'Patatas_fritas'],
  ['Tortillas', 3000, 'Tortilla_de_maíz'],
  ['Cereal', 7000, 'Copos_de_maíz'],
  ['Coca 600ml', 2200, 'Coca-Cola'],
  ['Pan de caja', 4500, 'Pan_de_molde'],
  ['Leche 1L', 2800, 'Leche'],
  ['Huevo Kg', 6400, 'Huevo_(alimento)'],
  ['Frijol Kg', 3900, 'Phaseolus_vulgaris'],
  ['Arroz Kg', 3200, 'Arroz'],
  ['Azúcar Kg', 2900, 'Azúcar'],
  ['Aceite 1L', 4200, 'Aceite_de_girasol'],
  ['Café soluble', 8900, 'Café_instantáneo'],
  ['Sopa instantánea', 1800, 'Fideos_instantáneos'],
  ['Jabón de barra', 1500, 'Jabón'],
  ['Papel higiénico', 3400, 'Papel_higiénico'],
  ['Plátano Kg', 2400, 'Musa_×_paradisiaca'],
]

async function fetchThumbnail(article) {
  const url = `https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article)}`
  const res = await getWithRetry(url)

  const json = await res.json()
  // originalimage is often a 4000px photo; the thumbnail is plenty for a tile
  // and keeps the images folder small enough to back up casually.
  const src = json.thumbnail?.source ?? json.originalimage?.source
  if (!src) throw new Error('no image on that article')
  return src
}

async function download(url, imageDir) {
  const res = await getWithRetry(url)

  const type = res.headers.get('content-type') ?? ''
  const ext = type.includes('png') ? '.png' : type.includes('svg') ? '.svg' : '.jpg'
  const filename = `${crypto.randomUUID()}${ext}`
  fs.writeFileSync(path.join(imageDir, filename), Buffer.from(await res.arrayBuffer()))
  return filename
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  const imageDir = path.join(dataDir, 'images')
  fs.mkdirSync(imageDir, { recursive: true })
  db.openDatabase(dataDir)

  if (process.argv.includes('--reset')) {
    for (const p of db.listProducts()) db.deactivateProduct(p.id)
    console.log('deactivated existing products')
  }

  const existing = new Set(db.listProducts().map((p) => p.name.toLowerCase()))
  let added = 0

  for (const [name, priceCents, article] of DEMO) {
    if (existing.has(name.toLowerCase())) {
      console.log(`skip   ${name} (already there)`)
      continue
    }
    try {
      const imageFile = await download(await fetchThumbnail(article), imageDir)
      db.createProduct({ barcode: null, name, priceCents, imageFile, stock: 12 })
      console.log(`added  ${name}`)
      added++
      await sleep(350) // stay under Wikimedia's rate limit
    } catch (err) {
      // A missing photo is not a reason to skip the product — an image-less
      // tile still sells, it just shows initials instead.
      db.createProduct({ barcode: null, name, priceCents, imageFile: null, stock: 12 })
      console.log(`added  ${name} (sin imagen: ${err.message})`)
      added++
    }
  }

  // Backfill pass: anything that lost its photo to a rate limit gets another
  // go, slower this time. Re-running the whole script would skip these, since
  // the product row already exists.
  const articles = new Map(DEMO.map(([name, , article]) => [name.toLowerCase(), article]))
  let fixed = 0

  for (const product of db.listProducts()) {
    if (product.image_file) continue
    const article = articles.get(product.name.toLowerCase())
    if (!article) continue

    try {
      const imageFile = await download(await fetchThumbnail(article), imageDir)
      db.updateProduct(product.id, {
        barcode: product.barcode,
        name: product.name,
        priceCents: product.price_cents,
        imageFile,
      })
      console.log(`imagen ${product.name}`)
      fixed++
      await sleep(1500)
    } catch (err) {
      console.log(`sin imagen todavia: ${product.name} (${err.message})`)
    }
  }

  console.log(`\ndone: ${added} added, ${fixed} images backfilled`)
  console.log(`images in ${imageDir}`)
  app.exit(0)
})
