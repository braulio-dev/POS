# Servidor de sincronización

The other half of cloud sync: a small HTTP service you run on your VPS. The
register pushes sales, cortes and stock movements to it, pulls back product
edits made anywhere else, and exchanges photos. It also takes its own backups.

No npm dependencies — Node's own HTTP server and Node's own SQLite. There is
nothing to `npm install`, nothing to audit, and nothing to break on a bump.

## Deploying with Docker Compose

    cd server
    cp .env.example .env
    # edit .env: set POS_DOMAIN, ACME_EMAIL and POS_SYNC_KEY
    docker compose up -d

Generate the key with:

    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

Point your domain's DNS **A record at the server before the first start** —
Caddy asks Let's Encrypt for a certificate on boot, and that fails if the name
does not resolve yet. Ports 80 and 443 must be reachable from the internet.

Both services are `restart: unless-stopped`, so they come back after a crash or
a reboot but stay down when you deliberately stop them.

    docker compose ps           # health
    docker compose logs -f pos-sync
    docker compose pull && docker compose up -d   # update Caddy
    docker compose up -d --build                  # after editing server.mjs

### Why it is shaped this way

- **The sync container publishes no ports.** Only Caddy is exposed; the server
  is reachable solely over the `pos` network. The key is a bearer token, so an
  open 8787 would hand it to anyone able to watch the traffic.
- **Caddy terminates TLS** and renews on its own — no certbot timer to forget.
  Its `caddy-data` volume holds the certificates; lose it and every restart
  requests fresh ones, which will hit Let's Encrypt's rate limit.
- **The image pins `node:22.14-alpine`** rather than floating on `node:22`.
  `node:sqlite` is still an experimental API that has changed between minors,
  and a register that silently stops syncing after an unattended base image
  bump is precisely the failure that pin prevents.
- **`CMD` is in exec form** so the process is PID 1 and gets `SIGTERM` directly.
  That is what triggers the shutdown backup on `docker compose down`.

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

Four entity types. `sale` and `corte` only ever travel upward — the register is
the only place they happen. `product` and `stock` travel both ways.

They are **separate entities on purpose.** `product` carries name, barcode,
price, photo, active flag and `trackStock`; `stock` carries only the quantity.
Each merges last-write-wins on its own timestamp. If stock rode inside the
product row, an edit made at home at 09:00 would roll back every sale the
register had already decremented since. Keep them separate in any replacement.

A server must also not echo a register's own changes back to it — hence
`storeId` on the request and `origin` on each stored change.
