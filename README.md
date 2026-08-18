# Punto de venta — Abarrotes "El Paisa"

Electron + React + SQLite register, built to run fullscreen on the store PC.

## Running it

    npm run dev      # Vite + Electron, windowed, hot reload
    npm run build    # typecheck + bundle the renderer into dist/
    npm start        # run the built app (fullscreen kiosk)

Opening http://localhost:5173 in a plain browser also works — `src/lib/api.ts`
swaps in an in-memory stand-in when the Electron bridge is absent. Handy for
layout work; nothing persists.

    npx electron scripts/capture.cjs .captures          # screenshots + scanner assertions
    npx electron scripts/capture.cjs .caps --real       # screenshot the real store data
    npx electron scripts/seed-demo.cjs                  # demo products with photos
    npx electron scripts/seed-demo.cjs --reset          # ...clearing the old ones first

Scripts run as `electron <file>` rather than `electron .`, which means Electron
cannot read the app name out of package.json. They call `app.setName` so
userData resolves to the same folder the real app uses; without it they would
quietly operate on `%APPDATA%/Electron` instead.

## Layout

    electron/main.cjs      window, IPC handlers, image storage, posimg:// protocol
    electron/preload.cjs   the only bridge between renderer and Node
    electron/db.cjs        schema + queries (node:sqlite, no native build step)
    electron/sync.cjs      cloud sync worker: drains the outbox, pulls edits
    src/App.tsx            screen state machine: sale -> payment -> change
    src/lib/tender.ts      cash validation policy  <- has an open TODO
    src/lib/stock.ts       out-of-stock policy     <- has an open TODO
    src/lib/money.ts       integer-cent maths and formatting
    electron/ipc.cjs       every renderer-reachable channel, shared with the harness
    electron/escpos.cjs    receipt + corte byte builder for the 58mm printer
    electron/printer.cjs   raw spooling via scripts/raw-print.ps1
    src/hooks/             barcode scanner (keyboard-wedge listener)
    src/components/        Header, ProductGrid, Cart, modals, change screen
    server/                sync server for your VPS + the browser admin page
    server/docker-compose.yml  the deployment: sync server + Caddy for TLS

## Configuración

Behind a password — **the default is `1234`**, changeable in
Configuración → Seguridad. The hash is salted per install and lives in the main
process; the renderer can only ever ask "is this right?". The same password
guards the Inventario screen, since changing what the shelf claims to hold is an
owner action rather than a cashier one.

Tabs: **General** (store name), **Impresora**, **Corte** (cash threshold and the
low-stock mark), **Sincronización**, **Respaldos** (the server's backup list,
with a "respaldar ahora" button), **Seguridad**.

## Inventory

Every product carries a `stock` count. Sales decrement it inside the same
transaction that records the sale, so the two can never disagree. The box icon
in the header opens the physical-count screen: retype quantities, and GUARDAR
writes them all in one transaction.

The policy lives in `src/lib/stock.ts`, and it is deliberately permissive:

- **Selling past zero never blocks.** The customer is holding the item; a
  miscounted shelf does not get to veto a sale that is physically happening.
- **Stock is allowed to go negative.** `-3` means three more went out than the
  books thought, which is exactly the signal saying *recount this shelf*.
  Clamping at zero would throw that away and make the books look fine.
- **Goods sold loose carry `track_stock = 0`.** Without it, frijol por kilo sits
  at zero forever, reports AGOTADO on every scan, and teaches the cashier to
  ignore the warnings that do matter.
- **Only actionable news reaches the counter.** "Quedan 2" is worth a toast —
  they can tell the owner to reorder. "Sin existencia" is not, so it shows on
  the card badge and the Inventario screen where the owner will see it.

## Corte de caja

Once cash taken since the last corte passes the threshold (default $2,000,
set it to 0 to switch the reminder off), a banner appears above the footer and
stays until the cut is made. Cash counted is the sale total, not the amount
handed over — the change came back out of the same drawer.

Taking a corte writes a row, prints a slip with the period it covers, and starts
a new period. The cut commits to SQLite before anything is spooled, so an
out-of-paper printer costs a slip and never the record.

## Where the data lives

`%APPDATA%/pos-elpaisa/pos.db` — SQLite, the source of truth. Product photos go
in `%APPDATA%/pos-elpaisa/images/`. Products, stock, sales, line items, cortes
and settings all live there, and a sale never depends on the network.

The `outbox` table records every change in the same transaction that makes it.
`electron/sync.cjs` drains it whenever the server is reachable and applies
whatever came back. See `server/README.md` for the server side and the protocol.

The server backs itself up on a timer (every 5 minutes out of the box) and can
purge history past a retention window. Both are visible from Configuración →
Respaldos. It ships as a Docker Compose stack with Caddy for TLS.

Sync merges last-write-wins, with product metadata and stock kept as **separate
entities on separate timestamps** — otherwise editing a price from home would
roll back every sale the register had rung up since that edit was made.

## Hardware

- **Barcode scanner** — Datalogic, VID_05F9/PID_2602, enumerates as a plain HID
  keyboard. No driver, no config. `useBarcodeScanner` separates it from real
  typing by timing (bursts under 50ms/char ending in Enter) and strips the code
  back out of whatever field it leaked into.
- **Receipt printer** — POS58 (driver `POS58ENG`, port USB003), 58mm / 32 cols.
  Driven with raw ESC/POS through the Windows spooler, so no native module and
  nothing to compile. Settings screen picks the queue and prints a test page.
- **Cash drawer** — mechanical, opened by hand. Nothing to integrate.

Printing never blocks a sale: the sale commits to SQLite and the change screen
appears first, then the ticket spools. A dead printer costs you a ticket, never
a recorded sale.

## Not built yet

Editing and deleting products from the register's own UI (the browser admin page
on the server does both), voids and refunds, a per-product "sold loose, do not
track stock" flag, and reprinting a past ticket.

Demo product photos come from Wikimedia under CC licences — fine as
placeholders, but shoot the real shelf before this runs the store.
