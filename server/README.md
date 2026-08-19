# Servidor de sincronización

The other half of cloud sync: a small HTTP service you run on your VPS. The
register pushes sales, cortes and stock movements to it, pulls back product
edits made anywhere else, and exchanges photos. It also takes its own backups.

No npm dependencies — Node's own HTTP server and Node's own SQLite. There is
nothing to `npm install`, nothing to audit, and nothing to break on a bump.

## Deploying with Docker Compose

TLS is handled by the Caddy already running on this VPS; the stack is just the
sync server.

    cd server
    cp .env.example .env
    # edit .env: set POS_SYNC_KEY
    docker compose up -d

Generate the key with:

    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

At this point the server is running but only reachable on loopback. Wire up
Caddy next — see **[Setting up Caddy](#setting-up-caddy)** below.

    docker compose ps           # health
    docker compose logs -f pos-sync
    docker compose up -d --build   # after editing server.mjs

### Why it is shaped this way

- **The port is bound to `127.0.0.1`, not `0.0.0.0`.** Caddy reaches it over
  loopback; nothing else can. Do not shorten the mapping to `"8787:8787"` — that
  publishes an API whose only auth is a bearer token straight to the internet,
  and Docker writes its iptables rules ahead of ufw, so the port stays reachable
  even when `ufw status` says otherwise.
- **The image pins `node:22.14-alpine`** rather than floating on `node:22`.
  `node:sqlite` is still an experimental API that has changed between minors,
  and a register that silently stops syncing after an unattended base image
  bump is precisely the failure that pin prevents.
- **`CMD` is in exec form** so the process is PID 1 and gets `SIGTERM` directly.
  That is what triggers the shutdown backup on `docker compose down`.

## Setting up Caddy

Caddy is already running on this VPS, so this is one site block added to the
config you have — no new service, no certbot, no renewal timer.

### 1. Point DNS at the server

Create an **A record** for the hostname (say `pos.tudominio.com`) pointing at
the VPS's public IP. Do this *first*: Caddy asks Let's Encrypt for a certificate
the moment the site block loads, and the challenge fails if the name does not
resolve yet. Check it has propagated:

    dig +short pos.tudominio.com

Ports **80 and 443 must be open** to the internet. Port 80 is not optional —
it is how the HTTP-01 challenge is answered, and Caddy also uses it to redirect
to HTTPS.

    sudo ufw allow 80,443/tcp

### 2. Add the site block

Open `/etc/caddy/Caddyfile` and append the contents of `Caddyfile.snippet`,
changing the hostname:

    pos.tudominio.com {
        encode gzip

        # Product photos are uploaded whole; the default body cap would reject
        # anything off a modern phone camera.
        request_body {
            max_size 30MB
        }

        header {
            Strict-Transport-Security "max-age=31536000; includeSubDomains"
            X-Content-Type-Options "nosniff"
            X-Frame-Options "DENY"
            Referrer-Policy "no-referrer"
            -Server
        }

        reverse_proxy 127.0.0.1:8787
    }

Two things that are deliberately absent:

- **No `tls` directive.** Caddy provisions and renews the certificate itself as
  soon as it sees a public hostname. Adding one usually breaks that.
- **No proxy timeouts.** Caddy 2 sets none by default, which is exactly what a
  slow photo upload from home over domestic broadband needs. (`read_timeout`
  and `write_timeout` are *not* valid inside `transport http` — they are
  server-level options, and putting them there fails validation.)

`request_body max_size` is the one you do need: without it a phone photo is
rejected with a 413 and the admin page just says the upload failed.

### 3. Validate and reload

Reload rather than restart — it swaps config with no dropped connections, and
it refuses to apply a broken file:

    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy

### 4. Check it works

    curl https://pos.tudominio.com/health

Expect `{"server":"pos-sync","version":1,...}`. That route needs no key, which
is why it is safe to curl and why the container healthcheck uses it.

Then confirm the key path works end to end:

    curl -s https://pos.tudominio.com/api/products \
      -H "Authorization: Bearer $POS_SYNC_KEY"

A `401` means the key in `.env` and the one you are sending disagree. Finally,
open `https://pos.tudominio.com` in a browser — that is the admin page.

### If it does not come up

    sudo journalctl -u caddy -f          # certificate + proxy errors
    docker compose logs -f pos-sync      # the app behind it
    sudo ss -tlnp | grep 8787            # should show 127.0.0.1:8787, not 0.0.0.0

Common causes, in the order they usually bite:

| Symptom | Cause |
| --- | --- |
| Certificate never issued | DNS not propagated yet, or port 80 closed |
| `502 Bad Gateway` | Container not running, or Caddy is in Docker and cannot see the host's loopback |
| `413` on photo upload | `request_body max_size` missing from the site block |
| Works on `:8787`, not on `443` | Site block never loaded — check `caddy validate` output |

### If your Caddy runs in Docker

A container cannot reach the host's `127.0.0.1`, so the loopback binding is no
use to it. Drop the `ports:` block from `docker-compose.yml`, put both
containers on the same network, and proxy to the service name:

    # docker-compose.yml
    services:
      pos-sync:
        networks: [web]
    networks:
      web:
        external: true

    # Caddyfile
    reverse_proxy pos-sync:8787

Find the network your Caddy container is already on with:

    docker inspect -f '{{json .NetworkSettings.Networks}}' <caddy-container>

### Pointing the register at it

**Configuración → Sincronización** (password, default `1234`):

- **Dirección del servidor** — `https://pos.tudominio.com`, no trailing slash
- **Clave** — the same `POS_SYNC_KEY`
- **Nombre de esta caja** — anything; it identifies this register in the change
  feed. Two registers must not share a name.

Tick **Sincronizar con el servidor**, then **Probar conexión**.

## Backups

On by default. Snapshots go to `/data/backups` inside the `pos-data` volume.

| Variable | Default | Meaning |
| --- | --- | --- |
| `POS_BACKUP_ENABLED` | `1` | Take snapshots on a timer. |
| `POS_BACKUP_INTERVAL` | `5m` | How often. Units `s`, `m`, `h`, `d`. |
| `POS_BACKUP_KEEP` | `48` | How many to retain; the oldest are pruned. |
| `POS_BACKUP_DIR` | `<data>/backups` | Where they land. |

Set `POS_BACKUP_INTERVAL=1d` when the shop has settled. At `5m` with `KEEP=48`
you hold four hours of history; at `1d` the same setting holds seven weeks.

A snapshot is also taken on startup and on shutdown.

Backups use `VACUUM INTO`, not a file copy. A plain `cp` of a WAL database can
capture a torn state — the `-wal` file holds committed pages the `.db` file does
not have yet — whereas `VACUUM INTO` writes a consistent single-file copy and
does not block the register from syncing while it runs.

You can see the list, take one on demand, and download them from either the
admin page (**Mantenimiento**) or the register (**Configuración → Respaldos**).

**Copy them off this machine.** A backup on the same disk as the database only
survives corruption, not a dead server. A cron on your laptop is enough:

    scp -r vps:/var/lib/docker/volumes/server_pos-data/_data/backups ./

## Purging

**Off by default**, because it deletes history permanently.

| Variable | Default | Meaning |
| --- | --- | --- |
| `POS_PURGE_ENABLED` | `0` | Master switch. |
| `POS_PURGE_INTERVAL` | `1d` | How often retention runs. |
| `POS_PURGE_DAYS` | `365` | Drop sales and cortes older than this. |
| `POS_PURGE_CHANGES_DAYS` | `30` | Drop sync-feed rows older than this. |
| `POS_STALE_STORE_DAYS` | `30` | A register unseen this long stops holding the feed open. |

Preview before committing — the admin page's **Ver qué se borraría** button, or:

    curl -sX POST https://tu.dominio/api/purge \
      -H "Authorization: Bearer $POS_SYNC_KEY" \
      -H 'Content-Type: application/json' -d '{"dryRun":true}'

Two safety properties worth knowing about:

**A purge always backs up first, and aborts if the backup fails.** A full disk
must not be the reason a year of sales disappears.

**The sync feed is never trimmed out from under a register.** A register's
cursor is a `seq` in the `changes` table. Deleting rows below a cursor still in
use does not raise an error — the register simply never sees those catalogue
edits again. So the server records how far each register has read and only trims
below the oldest cursor still in play. `POS_STALE_STORE_DAYS` is the escape
hatch: a decommissioned till would otherwise freeze the feed forever.

Orphaned photos — files no product points at — are swept too, with a week's
grace so an upload that has not been attached yet is never taken mid-flight.

## Editing from home

Open `https://tu.dominio` in a browser. It asks for the same key, then gives you:

- **Productos** — name, barcode, price, quantity, a **Llevar** checkbox for
  whether to track stock at all, and a **Foto** button to upload a photo.
- **Ventas** and **Cortes** — read-only history.
- **Mantenimiento** — backup list with downloads, and the purge controls.

The register picks changes up on its next cycle (60s by default) and downloads
photos itself.

Quantity is only sent when you actually type a new number, so saving a price
edit never stamps a stale count over what the register has been counting down
from all day.

## Running it without Docker

    POS_SYNC_KEY='...' node server/server.mjs

Requires **Node 22.5+** for `node:sqlite`; on some builds it needs
`node --experimental-sqlite server.mjs`. Put it behind a TLS terminator either
way — the same reasoning as above applies.

## Backups vs. the register's own database

The register's `%APPDATA%/pos-elpaisa/pos.db` is the real source of truth for
sales; this server is a copy plus the place catalogue edits originate. These
backups do not cover a register that has never synced. Back up both.

## The protocol

If you ever replace this with something else, the register needs only these
routes. All except `/health` and `/` require `Authorization: Bearer <key>`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness. Used by **Probar conexión** and the container healthcheck. |
| `POST /sync` | Push and pull in one call (below). |
| `GET /images` | `{ files: [...] }` — what the server holds. |
| `GET /images/:file` | Download bytes. |
| `PUT /images/:file` | Upload bytes. |
| `GET /api/maintenance` | Backup/purge status, used by the register's Respaldos tab. |
| `POST /api/backup` | Snapshot now. |

The admin page uses a few more. A replacement server does not need them for a
register to work, only for the browser page to have anything to show:

| Route | Purpose |
| --- | --- |
| `GET /api/movements` | Cash in and out of the drawer, newest first, with totals. |
| `GET /api/report?from=&to=` | Totals, per-day and per-hour buckets, and top sellers for a date range. |
| `GET /api/reorder?below=&days=` | What to buy: at or below the mark, ordered by what runs out first. |
| `GET /api/export/{ventas,cortes,movimientos}.csv?from=&to=` | The same ranges as CSV. |
| `GET /vendor/chart.umd.min.js` | Chart.js, vendored in `server/vendor/`. Unauthenticated: public library code, none of the shop's data. |

Dates in those routes are **shop-local** calendar days (`YYYY-MM-DD`), not UTC.
Rows are stored as UTC instants and bucketed through `POS_TZ`, which defaults to
`America/Mexico_City`; without that step every sale after 6pm lands on the wrong
day and both days come out wrong.

`POST /sync` request:

```json
{
  "storeId": "caja-tienda",
  "since": "42",
  "changes": [
    { "entity": "product", "uuid": "…", "at": "ISO", "payload": { "…": "…" } }
  ]
}
```

Response:

```json
{
  "cursor": "57",
  "changes": [ { "entity": "product", "uuid": "…", "payload": { "…": "…" } } ]
}
```

Five entity types. `sale`, `corte` and `movement` only ever travel upward — the
register is the only place they happen. `product` and `stock` travel both ways.

`movement` is cash in or out of the drawer for a reason that is not a sale: the
fondo, a supplier paid out of the till, a retiro. It carries `kind` ('in' or
'out'), a always-positive `amountCents`, a `reason` and an optional `person`.
The direction lives in `kind` rather than in the sign, so no query can sum a mix
of signs into a meaningless total. A `corte` also carries those movements
totalled onto itself, plus what the drawer was expected to hold and what the
cashier actually counted — denormalised deliberately, so a slip reprinted next
year shows the same figures it showed on the day.

They are **separate entities on purpose.** `product` carries name, barcode,
price, photo, active flag and `trackStock`; `stock` carries only the quantity.
Each merges last-write-wins on its own timestamp. If stock rode inside the
product row, an edit made at home at 09:00 would roll back every sale the
register had already decremented since. Keep them separate in any replacement.

A server must also not echo a register's own changes back to it — hence
`storeId` on the request and `origin` on each stored change.
