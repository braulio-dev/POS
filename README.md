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
    electron/terminal.cjs  card terminal drivers (manual / Clip / Mercado Pago)
    src/lib/tender.ts      payment + tender policy <- has an open TODO
    src/lib/stock.ts       out-of-stock policy     <- has an open TODO
    src/lib/weight.ts      por-kilo policy: what a kilo costs, and what $50 weighs
    src/lib/money.ts       integer-cent maths and formatting
    electron/ipc.cjs       every renderer-reachable channel, shared with the harness
    electron/escpos.cjs    receipt + corte byte builder for the 58mm printer
    electron/printer.cjs   raw spooling via scripts/raw-print.ps1
    src/hooks/             barcode scanner (keyboard-wedge listener)
    src/components/        Header, ProductGrid, Cart, modals, change screen
    server/                sync server for your VPS + the browser admin page
    server/docker-compose.yml  the deployment (Caddy config in Caddyfile.snippet)

## Configuración

Behind a password — **the default is `1234`**, changeable in
Configuración → Seguridad. The hash is salted per install and lives in the main
process; the renderer can only ever ask "is this right?". The same password
guards the Inventario screen, since changing what the shelf claims to hold is an
owner action rather than a cashier one.

Tabs: **General** (store name), **Impresora**, **Báscula** (how scale labels are
encoded), **Corte** (cash threshold, fondo de caja and the low-stock mark),
**Terminal** (card payments), **Sincronización**, **Respaldos** (the server's
backup list, with a "respaldar ahora" button), **Seguridad**.

Two header buttons are deliberately *not* behind the password: **Tickets**
(reprinting) and **Entradas y salidas** (cash movements). Neither is an owner
decision — a reprint moves no money, and a salida happens whether or not the
owner is in the shop. Locking the second one would not stop the money leaving;
it would only stop the record of it being made, which is precisely the
unexplained faltante the corte exists to catch.

## Paying with a card terminal

COBRAR offers three ways to pay: **EFECTIVO**, **TARJETA** and **MIXTO** (part
cash, part card — what happens when a card is declined partway or the customer
wants to break a large bill).

The split is the source of truth, not the label: every sale stores `cash_cents`
and `card_cents`, they must add up to the total, and the main process re-derives
both the split and the method name before writing. There is deliberately no way
to record a card sale that still credits the drawer.

Two ways to drive the terminal, set in Configuración → Terminal:

- **Captura manual** (the default). The cashier charges on the terminal's own
  keypad, watches it approve, and presses COBRAR. That is the whole flow — the
  register asks for nothing else. TARJETA has no fields at all; MIXTO has two
  amounts and nothing more. No credentials, no internet, works with any terminal.

  Nothing is typed here because there is nothing the register could honestly
  verify: it never spoke to the terminal, so an authorisation number retyped off
  a slip would be an unchecked string costing keystrokes at the counter with a
  customer waiting. The amount is the one fact it actually knows, and the amount
  is what the corte needs.
- **Conectada**. The register pushes the amount to the terminal over the
  vendor's API and polls until the customer has paid. The reference, card brand
  and last four come back on their own — still nothing typed, which is the point
  of connecting it. Only here is approval a real fact, so only here will the
  screen hold the sale until the terminal answers. Needs an integration account,
  a device id and working internet; if the terminal cannot be reached the screen
  drops back to manual on its own, so a sale is never lost to a dead connection.

The Mercado Pago Point driver follows their published device payment-intent
flow. **The Clip driver follows the same shape but its routes have not been
verified against a live device** — check them against the credentials Clip
issues your store before turning "mandar el monto a la terminal" on. Manual
capture needs none of this and is complete as shipped.

## Selling by weight (por kilo)

Every product answers one question — **¿cómo se vende?** — with one of two
answers: **por pieza** or **por kilo**. It is deliberately the flag that already
existed (`track_stock`) rather than a second one: "this has no pieces to count"
and "this is measured some other way" are the same fact, and two switches that
must agree eventually will not.

It used to be a checkbox labelled *Inventario*, which named the database column
rather than the decision, and whose unticked state was visible only as a
greyed-out quantity box. Both screens and the admin page now show two labelled
options, because the choice settles three things at once — whether a count is
kept, whether the price means a piece or a kilo, and whether the till asks for a
weight at the counter — and a checkbox can only ever label one of them.

Tapping such a product does not add a line — there is no "one" frijol. It opens
the scale screen, which takes the sale from either end of the counter
conversation:

- **Por peso** — the cashier reads the scale and types `1.35`. Quarter, half,
  one and two kilo shortcuts cover most of it in a single tap.
- **Por importe** — "me da $50 de jamón". The customer named the money, so the
  money is exact and the weight is what gets solved for; the slicer is told how
  much to cut instead of the customer being handed $49.60 worth and a shrug.

Either way the line stores both facts — what was weighed and what it cost — and
the money is rounded to the centavo exactly once, when the line is added. Every
screen and the printed ticket read that stored figure rather than re-deriving
`precio × kilos`, because two roundings on two code paths is how a receipt ends
up with lines that do not add up to the total printed under them.

Each weighing is its own line. Two trips to the scale are two facts, and a
customer querying the ticket is querying one of them; collapsing them into a
single "1.600 kg" would be correct in total and unable to show where either half
came from. Tapping a weighed line removes it outright — the cashier re-weighs
rather than editing a number they cannot see.

Stock is never moved by a weight line, from either side: the product is
untracked, and the line's own unit says kg. Both have to hold before a count
changes.

### Scale labels

A scale that prints labels puts the measurement inside the barcode, as an
EAN-13 in the `2` range GS1 reserves for codes a shop assigns itself:

    2X IIIII VVVVV C     flag · item code · grams or centavos · check digit

Turn it on in Configuración → Báscula, where the one thing that has to be
declared is **which of the two** `VVVVV` holds — nothing in the label says, and
reading a price as a weight would sell 4.5 kg of ham to a customer who asked for
$45 of it. That is why it ships off rather than guessing. The product is found
by its five-digit item code, registered in the product's barcode field either
bare or with the label's leading digits.

The check digit is deliberately not verified: scales disagree about how it is
computed, and rejecting a label the scanner read perfectly well would send the
cashier back to typing for nothing. A bad digit surfaces as an unknown item
code, which the register already handles.

A real barcode always wins first. Scale codes live in the range a shop assigns
itself, so a product deliberately registered with one of those codes is never
hijacked by the decoder underneath it.

## Inventory

Every product carries a `stock` count. Sales decrement it inside the same
transaction that records the sale, so the two can never disagree. The box icon
in the header opens the physical-count screen: retype quantities, and GUARDAR
writes them all in one transaction. New products are created there too, behind
the same password — setting a price is an owner decision, not a cashier one, so
the sale screen has no add button.

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
stays until the cut is made.

### What the drawer should hold

The cut is a reconciliation, not a report. Five numbers make it:

    fondo inicial + efectivo de ventas + entradas − salidas = ESPERADO
                                                   contado = CONTADO
                                             contado − esperado = DIFERENCIA

**Fondo inicial** is whatever the previous cut deliberately left behind, so the
periods chain and the fondo can never be double counted. Only the very first cut
on a fresh register has no predecessor; that one falls back to Configuración →
Corte.

**Entradas y salidas** are cash that moved for a reason that is not a sale —
paying the tortilla delivery out of the till, a retiro to the back room, the
owner dropping in change. Recording them is what makes the difference figure
mean anything: without somewhere to write them down, every legitimate errand
shows up at closing time as an unexplained faltante, and a cashier blamed for
four faltantes they can explain stops believing the fifth one matters. A reason
is required; the money is not, which is why the screen is not locked.

**Contado** is the one figure on the whole slip that cannot be rebuilt later.
Everything else is derivable from the sales table years from now; what was
physically in the drawer exists for ten seconds on a counter and then is gone.
So the cut will not go through without it — and the field is never prefilled
with the expected amount, because a count that starts from the answer is a
confirmation, not a count.

A difference **does not block the cut**. The money is already however much it
is; refusing to close would leave the drawer open, the period unclosed and the
discrepancy unrecorded, which is strictly worse than writing it down. Nor is it
absorbed: `expected_cents` keeps saying what the books think and `counted_cents`
what the room says, so the disagreement survives to be looked at — in the corte
list in Configuración and in the admin page's Cortes tab.

### What the slip says

The ticket ends in two signature lines, **Entrega** and **Recibe**, and that is
what decides its headline. A signature says "this much money passed from my
hands to yours", so the big number above it is **ENTREGA**: what was counted,
minus the fondo staying behind for the next shift. Printing the period's takings
there would have two people signing for a figure neither of them ever held.

Above it, the arithmetic that got there — fondo, ventas, entradas, salidas,
esperado, contado, and FALTAN/SOBRAN with the word before the number. A cut that
prints only its conclusion cannot be checked by the person signing for it.

Cuts taken before any of this existed print exactly the slip they always
printed: their `counted_cents` is NULL, which means "nobody was asked", and that
is shown as *sin conteo* rather than as a difference of zero. "Nobody checked"
and "it balanced" are opposite pieces of news and must never look the same.

**Cash counted is the cash leg of each sale** — not the sale total, and not the
amount handed over. Money that went through the card terminal never entered the
drawer, and change came back out of it. The threshold is measured against cash
only: card takings sitting in a Clip account are not a reason to walk to the
back with a bag of money, and letting them trip the banner would train the
cashier to ignore it.

A corte therefore records total sold, card and cash alongside the reconciliation
above. The cut commits to SQLite before anything is spooled, so an out-of-paper
printer costs a slip and never the record.

## Where the data lives

`%APPDATA%/pos-elpaisa/pos.db` — SQLite, the source of truth. Product photos go
in `%APPDATA%/pos-elpaisa/images/`. Products, stock, sales, line items, cortes
and settings all live there, and a sale never depends on the network.

The `outbox` table records every change in the same transaction that makes it.
`electron/sync.cjs` drains it whenever the server is reachable and applies
whatever came back. See `server/README.md` for the server side and the protocol.

"Enviados 0" after a sync normally means everything is already up to date —
only changes since the last run are sent. The exception is a register that was
already running before sync existed: its catalogue was never queued, so the
first sync backfills the whole thing automatically. **Reenviar todo** in
Configuración → Sincronización forces that by hand if the server is ever missing
something.

The server backs itself up on a timer (every 5 minutes out of the box) and can
purge history past a retention window. Both are visible from Configuración →
Respaldos. It ships as a one-service Docker Compose stack, bound to loopback and
fronted by whatever reverse proxy already runs on the VPS.

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

## Reprinting a ticket

The register has always been able to survive a dead printer — the sale commits
to SQLite before anything is spooled — but until now surviving it cost the
ticket permanently. The receipt icon in the header lists the last thirty sales
with a REIMPRIMIR button on each, and the change screen carries one for the sale
just closed, which is where a missing ticket is usually noticed.

A reprint takes **only a uuid**. The slip is rebuilt in the main process from
what was recorded, so a copy is physically incapable of showing a price, a total
or a payment method the sale does not have on file. It comes out stamped
**\*\*\* COPIA \*\*\*** under the header, so it cannot be handed over — or added
up at the end of the week — as a second sale.

## Reports and the shopping list

Two tabs on the admin page, both reading the history the register has already
pushed up. Nothing new is recorded for them.

**Reportes** takes a date range (with Hoy / 7 días / 30 días shortcuts) and
answers: what was sold, split cash against card, the average ticket, sales per
day, sales per hour of the day, and what sells best. Ventas, cortes and
movimientos each export as CSV over the same range, written with a BOM because
the person opening them opens them in Excel, and Excel reads a BOM-less UTF-8
file as Latin-1 and turns every *Jamón* into *JamÃ³n*.

Two decisions worth knowing about:

- **Days are the shop's days.** Sales are stored as UTC instants, which is the
  only sane thing to store, but "how did we do on Tuesday" is a question about
  the calendar on the wall. In Mexico City that is six hours off, so bucketing
  on the raw timestamp files every sale after 6pm under the following day and
  makes both days wrong. Set `POS_TZ` on the server if the shop is somewhere
  else; it defaults to `America/Mexico_City`.
- **Top sellers rank by money, not by units.** Units cannot be ranked against
  each other at all once anything is sold by weight: one line counts kilos, the
  next counts pieces, and "37 against 37" compares nothing. Revenue means the
  same thing on every line, so it does the ranking, and each row still shows its
  own quantity in its own unit.

**Qué falta** is the list to take to the supplier: everything at or below the
low mark, ordered by **what runs out first** rather than by what has the
smallest number. Three left of something selling thirty a day is an emergency;
three left of something selling one a week is not, and a list sorted by count
puts them in the wrong order. Empty and oversold shelves sort to the top, and
"Copiar lista" puts it on the clipboard as text, because the trip to the bodega
happens with a phone rather than with this table.

Products sold por kilo are absent from it by design. They keep no count, so they
would sit at zero forever and bury the rows that can actually be acted on —
the same reasoning that keeps them from reporting AGOTADO at the till.

## Not built yet

Editing and deleting products from the register's own UI (the browser admin page
on the server does both), and voids and refunds.

Demo product photos come from Wikimedia under CC licences — fine as
placeholders, but shoot the real shelf before this runs the store.
