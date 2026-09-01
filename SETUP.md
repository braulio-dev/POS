# Setting up a new register

Two ways to run this on a counter. Pick one — they are alternatives, not layers.

| | **Profile A — the app locks itself** | **Profile B — something else locks it** |
|---|---|---|
| Fullscreen and exit handled by | This app (`Modo caja`) | An external kiosk layer |
| `Modo caja` setting | **ON** | **OFF** |
| `Abrir la caja al encender` | **ON** | **OFF** — the kiosk layer launches it |
| Way out | Ctrl + Alt + Q + owner's password | Whatever the kiosk layer provides |
| Needs | Any Windows edition, incl. Home | Pro/Enterprise/Education, or 3rd-party software |
| Install as | Per-user (default) | **Per-machine** — see step B2 |

`Modo caja` is a single fact — *this machine is a register* — and fullscreen and
the lock move together with it. That is why the two profiles are exclusive: in
Profile B the external layer already owns both, so turning `Modo caja` on would
put two locks with two different exit paths on the same window.

> **Windows 10/11 Home cannot do Profile B.** It supports neither Assigned
> Access nor Shell Launcher. On Home, use Profile A. See [^kiosk].

---

## 0. Build the installer

On a development machine, not the register.

```sh
git clone <repo> && cd pos-elpaisa
npm install
npm run dist
```

Output: `release\POS El Paisa Setup <version>.exe` [^exe]

Requires Node 22 or newer. There are no native modules to compile — the
database is Node's built-in `node:sqlite`, not `better-sqlite3` — so this is a
plain build with nothing to rebuild against Electron's ABI.

Copy that one `.exe` to the register. Nothing else travels: no Node, no repo,
no `node_modules`.

---

## Profile A — the app locks itself

For a shop counter on any Windows edition, including Home.

1. **Run the installer.** A short wizard asks who to install for. Take the
   default, **"Only for me"** — it lands under `%LOCALAPPDATA%` and asks for no
   administrator password. Tick **Run POS El Paisa** on the last page.
2. **Windows warns** — *"Windows protected your PC"*. The app is not
   code-signed. **More info → Run anyway**. Once only.
3. **It opens as an ordinary window.** The lock is off until someone turns it
   on. This is deliberate, and it is the step people forget.
4. **Change the password.** Configuración → Seguridad. Factory password is
   `1234`, and it is written in this file, so it is not a secret.
5. **Tick "Modo caja".** The window seals into fullscreen the instant you tick
   it — that is your confirmation it took. The banner above the checkbox states
   the mode in words.
6. **Tick "Abrir la caja al encender la computadora"** so the register returns
   by itself after a power cut. This writes an entry to the current user's
   `Run` key [^paths].
7. **Set the printer** in Configuración → Impresora and print a test ticket.
8. **Reboot and confirm** it comes back fullscreen and locked with nobody
   signing in to anything.

Before walking away, check the Seguridad tab reads **"Modo caja ACTIVO"**. An
unarmed register looks exactly like an armed one from the sales screen.

### Getting back out

- **Unlock:** Ctrl + Alt + Q, then the owner's password.
- **Re-lock:** Configuración → Seguridad → "Bloquear pantalla completa". A
  restart also re-seals it.
- **Close for good:** unlock first, then Seguridad → "Cerrar la caja".

There is no flag or safe mode that skips the password. If it is lost, the only
ways in are Task Manager or editing `pos.db` [^paths].

---

## Profile B — an external kiosk layer

For Windows Pro/Enterprise/Education with Assigned Access or Shell Launcher, or
any third-party kiosk software. The external layer puts the app on screen,
keeps it there, and owns the way out. This app stays an ordinary window and
does not fight it.

**B1. Confirm your layer can actually run this app.** [^kiosk]

- **Shell Launcher** replaces `Explorer.exe` with a Win32 app. Supports this
  app. **Enterprise / Education / IoT Enterprise only — not Pro.**
- **Assigned Access single-app kiosk** runs *"a single UWP application or
  Microsoft Edge"*. This app is Win32, so **it does not qualify**, on any
  edition.
- **Third-party kiosk software** generally works; it drives an ordinary Win32
  window.

**B2. Install per-machine.** A per-user install lands in the *installing
account's* `%LOCALAPPDATA%`, and the dedicated kiosk account has a different one
and cannot see it — the shell would fail to start.

No rebuild is needed. The installer asks: on the install-mode page choose
**"Anyone who uses this computer"**, accept the one administrator prompt, and
the app lands in `C:\Program Files\POS El Paisa\` — the same path for every
account. (Profile A can take the default, "Only for me".)

**B3. Install and configure the app, signed in as the kiosk account** so the
settings below are written to that account's database [^paths]:

- **Leave "Modo caja" OFF.** The external layer owns fullscreen and the exit.
- **Leave "Abrir la caja al encender" OFF.** The kiosk shell launches the app;
  under Shell Launcher the `Run` key would not fire anyway, because `Run` keys
  are processed by `Explorer.exe`, which is exactly what Shell Launcher
  replaces.
- Change the password and set the printer as in Profile A steps 4 and 7. The
  password still guards Configuración and Inventario.

**B4. Point the kiosk layer at the installed executable** [^whichexe] — never
at the Setup file. A kiosk shell configured to run `Setup.exe` reinstalls on
every login, then exits, and the shell relaunches it: an install loop.

**B5. Reboot and confirm** the kiosk account signs in automatically and lands
straight on the register.

---

## Hardening (worth doing under either profile)

1. **Run the register on a standard, non-administrator Windows account.** A
   non-admin cashier cannot install software or edit machine-wide policy.
2. **Auto-logon** to that account so a power cut needs no password.
3. **Disable Task Manager** — the one documented way to kill the app under
   Profile A. On Pro/Enterprise use `gpedit.msc` → User Configuration →
   Administrative Templates → System → Ctrl+Alt+Del Options → *Remove Task
   Manager*. **On Home there is no `gpedit.msc`**; set the registry value
   instead [^paths].

None of this stops Ctrl+Alt+Del or the Windows key — those belong to the OS
shell and no application can take them. The threat model here is a bored
cashier, not someone with physical administrator rights.

---

## Verifying a finished install

- [ ] Sales screen loads with the shop's products
- [ ] A test ticket prints
- [ ] Password is no longer `1234`
- [ ] Seguridad reads **"Modo caja ACTIVO"** (Profile A) or **"APAGADO"** (Profile B)
- [ ] Reboot lands on the register with no human input
- [ ] Profile A only: Alt+F4, F11 and Ctrl+W all do nothing
- [ ] Profile A only: Ctrl+Alt+Q asks for the password, and a wrong one is refused

---

## Updating an installed register

The update itself is one file: the new `Setup .exe` replaces the old install in
place. Nothing needs uninstalling first, and no data is exported or re-imported,
because the shop's data was never inside the install directory to begin with.

### What moves and what does not

| | On an update |
|---|---|
| Install directory [^paths] | Replaced wholesale — old version uninstalled, new one written |
| `%APPDATA%\pos-elpaisa\pos.db` | **Untouched.** Catalogue, sales, cortes, settings, sync cursor |
| `%APPDATA%\pos-elpaisa\images\` | **Untouched.** Product photos |
| Autostart entry [^paths] | Re-asserted by the new build on first launch |
| Owner's password, `Modo caja`, printer | All in `pos.db`, so all preserved |
| Sync server data | Different machine entirely — see *Updating the sync server* |

The one line that makes this true is in `electron-builder.yml`:

```yaml
deleteAppDataOnUninstall: false
```

NSIS uninstalls the old version before writing the new one, so an update runs
the uninstaller every time. That flag is the only thing standing between an
ordinary update and a wiped catalogue. Do not change it.

### 1. Back up first — two copies, they fail differently

**Server backup.** Configuración → Respaldos → *Respaldar ahora*. Runs
`VACUUM INTO` on the server, which writes a consistent single-file snapshot
without blocking writers, so the register can keep selling while it runs. This
protects you from a bad register, but not from losing the VPS.

**Local database copy.** **Close the app first**, then copy all three files
together — `pos.db`, `pos.db-wal`, `pos.db-shm` [^paths]. The database runs in
WAL mode, so recent writes live in the `-wal` file rather than in `pos.db`;
copying `pos.db` alone from a running register gives you a snapshot that is
silently missing the most recent sales. This is the copy that gets you back if
the update itself goes wrong.

### 2. Build, on the development machine

```sh
git pull
# bump "version" in package.json
npm install
npm run dist
```

Bump `version` even for a small change. It is what the built filename and
Add/Remove Programs will say, and it is the only way to tell from the counter
which build is actually on that machine.

Run the result on the dev machine once before it travels. `npm run dist` runs
`tsc --noEmit` first, so a type error stops the build — but nothing checks that
the app still *opens a database it has not seen before*, and that is the step
that matters here.

### 3. Update the sync server before the registers

Skip only if the release does not touch `server/`. On the VPS:

```sh
git pull
docker compose up -d --build
```

> **Never `docker compose down -v`.** The `-v` destroys the `pos-data` volume,
> which holds the server database *and* every automatic backup, since those are
> written to `/data/backups` inside that same volume. Plain `docker compose
> down` leaves the volume alone. If you want backups that survive losing the
> volume — or the VPS — copy them off the machine on a schedule.

Server first, registers after. Server-side migrations are additive
(`addColumnIfMissing`), and the server is written to tolerate a register that
has not been updated yet: a till that sends no payment split, for instance, has
its whole total credited to cash rather than being rejected. The reverse
ordering has no such guarantee.

### 4. Update each register

One at a time, so the shop can still sell on the other one.

1. Exit the register: Ctrl + Alt + Q and the owner's password (Profile A), or
   whatever the kiosk layer provides (Profile B).
2. Confirm `POS El Paisa.exe` is gone from Task Manager. An installer that has
   to fight a running process is where in-place updates go wrong.
3. Run the new `Setup .exe`, choosing **the same install scope as last time** —
   per-user or per-machine [^whichexe]. A mismatch does not overwrite anything;
   it leaves *two* installs on the machine, and the autostart entry keeps
   pointing at the stale one.
4. Launch it. Schema migrations run at open, before the window appears.

### 5. Verify

- [ ] Product count matches what the register had before
- [ ] A test ticket prints — the print script lives at an unpacked path outside
      `app.asar` [^paths], and a broken build breaks it silently
- [ ] Configuración → Sincronización shows a recent *última sincronización*,
      no error, and **pendientes back to 0**
- [ ] Version in Configuración matches what you built
- [ ] Reboot lands on the register with no human input (Profile A)

### Rolling back

Migrations are forward-only. `openDatabase` runs `CREATE TABLE IF NOT EXISTS`
and `addColumnIfMissing` on every launch — there is no schema version and there
are no down-migrations. So an older build opening a database a newer build has
already touched is untested territory: extra columns it does not know about are
usually harmless, but nothing guarantees it.

A rollback is therefore **two** steps, not one: reinstall the old `Setup .exe`
*and* restore the `pos.db` copy from step 1. Doing only the first is the case
nobody has tested.

> **Adding a register is not the same as updating one.** A second machine must
> get its own **NOMBRE DE ESTA CAJA** in Configuración → Sincronización before
> it syncs. The server filters each register's pull with `origin <> storeId`, so
> two registers sharing a name each become invisible to the other — the new one
> silently receives nothing but changes made from the admin page. Changing the
> name now rewinds that register's cursor automatically so it re-reads the feed
> from the start; older builds do not, and need `pos.db` deleted instead.

---

## Troubleshooting

**Tickets do not print.** Confirm the printer in Configuración → Impresora, then
check `raw-print.ps1` exists on disk [^paths]. Printing shells out to
`powershell.exe`, which cannot read inside `app.asar`, so that file is unpacked
deliberately. If it is missing, the build is wrong, not the printer.

**It does not start after a reboot (Profile A).** The `Run` entry [^paths] is
ordinary user-writable registry and anything can clear it. The app re-asserts it
at every launch, so open the app once and reboot again. If it clears repeatedly,
suspect cleanup software.

**It starts but is not fullscreen (Profile A).** `Modo caja` is off. Someone
unticked it, or this is a fresh install where step 5 was skipped.

**Password lost.** Task Manager to close the app, then delete `pos.db` [^paths]
to reset everything to factory — **this destroys the catalogue and sales
history**. Restore from a backup first if one exists.

**Upgrading.** See *Updating an installed register* above. Short version:
raise `version`, `npm run dist`, run the new installer on the register with the
same install scope. It replaces in place and leaves the database and product
images alone.

---

### Footnotes

[^exe]: **What `POS El Paisa Setup <version>.exe` is.** An NSIS
    self-extracting installer — a one-time delivery wrapper, not the app. It
    carries a compressed copy of the whole application: the Electron runtime
    (~100 MB of Chromium DLLs, ICU and locale data), your code as
    `app.asar` (~400 KB), and the unpacked print script. Run once, it
    decompresses everything into the install directory, creates Desktop and
    Start Menu shortcuts, registers an uninstaller in Add/Remove Programs,
    launches the app and exits. After that it has no further role and can be
    deleted. Because `oneClick: false`, it is a short wizard: it asks whether to
    install for this account only or for all users, and only the second choice
    raises a UAC prompt. Two switches help when deploying several registers:
    `/S` installs silently — per-user unless combined with `/allusers` — and
    `/D=C:\path` overrides the directory (`/D` must come last and unquoted).

[^whichexe]: **Which executable to run.** Always the *installed* one, never the
    Setup file:
    `%LOCALAPPDATA%\Programs\POS El Paisa\POS El Paisa.exe` for a per-user
    install, or `C:\Program Files\POS El Paisa\POS El Paisa.exe` for a
    per-machine one. This is the path a kiosk shell, a scheduled task or a
    shortcut should point at. The Setup file launches the app as a *separate*
    process and then terminates, so anything that watches it for exit — such as
    Shell Launcher — will see it finish immediately and relaunch it forever.

[^paths]: **Paths that matter.**

    | What | Where |
    |---|---|
    | Installed app (per-user) | `%LOCALAPPDATA%\Programs\POS El Paisa\POS El Paisa.exe` |
    | Installed app (per-machine) | `C:\Program Files\POS El Paisa\POS El Paisa.exe` |
    | Application code | `<install dir>\resources\app.asar` |
    | Print script | `<install dir>\resources\app.asar.unpacked\scripts\raw-print.ps1` |
    | Database | `%APPDATA%\pos-elpaisa\pos.db` (+ `-wal`, `-shm`) |
    | Product photos | `%APPDATA%\pos-elpaisa\images\` |
    | Autostart entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `electron.app.POS El Paisa` |
    | Uninstall entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\` (per-user install) |
    | Disable Task Manager | `HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System` → `DisableTaskMgr` (DWORD) = `1` |
    | Build output | `release\POS El Paisa Setup <version>.exe` |

    Everything under `%APPDATA%\pos-elpaisa` is the shop's data and is
    per-Windows-account. Install and configure signed in as the account that
    will actually run the register, or the settings land on the wrong profile.

[^kiosk]: **Edition support**, from Microsoft's own documentation.
    [Assigned Access](https://learn.microsoft.com/en-us/windows/configuration/assigned-access/)
    runs *"a single Universal Windows Platform (UWP) application or Microsoft
    Edge"* — Pro, Enterprise and Education are all listed, but a Win32 app like
    this one does not qualify on any of them.
    [Shell Launcher](https://learn.microsoft.com/en-us/windows/configuration/shell-launcher/)
    does replace the shell with a Win32 desktop application, but is limited to
    **Enterprise / Enterprise LTSC / Education / IoT Enterprise** — Pro is not
    supported. Home supports neither. Note also that Shell Launcher *"doesn't
    prevent a user from accessing other desktop applications and system
    components"* on its own; locking those down needs AppLocker or Group Policy
    on top.
