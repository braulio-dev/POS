const { app, globalShortcut } = require('electron')
const path = require('node:path')
const db = require('./db.cjs')

/**
 * Holds the register in fullscreen and decides when it is allowed out.
 *
 * The window is already created with `kiosk: true`, but kiosk mode only hides
 * the chrome — it does not stop F11, Alt+F4, Ctrl+W or the taskbar's close
 * button. Those all still end the shift. So the lock is enforced here, in the
 * main process, and the only thing that lifts it is `unlock()` answering to
 * db.verifyPassword.
 *
 * What this cannot do: Ctrl+Alt+Del and the Windows key belong to the OS shell
 * and no application can take them. This is a gate against a curious cashier,
 * the same threat model the Configuracion password was written for — not
 * against someone with physical admin rights on the machine.
 */

let win = null
let locked = false

/** Keys that would otherwise walk straight out of fullscreen. */
const SWALLOWED = [
  'F11',           // toggles fullscreen
  'Alt+F4',        // closes the window
  'CommandOrControl+W',
  'CommandOrControl+R',       // a reload mid-sale loses the cart
  'CommandOrControl+Shift+R',
  'CommandOrControl+Shift+I', // DevTools: the renderer must stay opaque
  'CommandOrControl+Shift+C',
]

function applyWindowLock() {
  if (!win || win.isDestroyed()) return
  win.setKiosk(locked)
  win.setFullScreen(locked)
  // Without this the cashier can still drag another window over the register,
  // which is enough to make the lock feel optional. Deliberately the 'normal'
  // level and not 'screen-saver': the higher levels also outrank native file
  // dialogs, and Inventario opens one to pick a product image.
  win.setAlwaysOnTop(locked, 'normal')
  if (locked) win.focus()
}

function applyShortcutLock() {
  globalShortcut.unregisterAll()
  if (!locked) return
  // Registering a shortcut to do nothing is how you consume it: the accelerator
  // is claimed process-wide, so the default handler never sees the keystroke.
  for (const accelerator of SWALLOWED) {
    try { globalShortcut.register(accelerator, () => {}) } catch { /* held by another app */ }
  }
}

/**
 * Arms the lock on a window. Called once, from main.cjs, after createWindow.
 *
 * `startLocked` is main.cjs's verdict on this launch: the kioskMode setting is
 * on AND this is not a development run. Attach happens either way, so an
 * unarmed machine can still be armed later without restarting.
 */
function attach(browserWindow, { startLocked }) {
  win = browserWindow
  locked = Boolean(startLocked)

  // The close event is the last line of defence and the important one: every
  // other route out (Alt+F4, the taskbar, a shutdown-adjacent signal) ends up
  // here, so refusing it once covers all of them.
  win.on('close', (event) => {
    if (locked) event.preventDefault()
  })

  // globalShortcut only fires while the app has focus, and a determined poke at
  // the window can drop focus. before-input-event is the belt to that braces:
  // it sees keys the moment the renderer would.
  win.webContents.on('before-input-event', (event, input) => {
    if (!locked || input.type !== 'keyDown') return
    const key = String(input.key).toLowerCase()
    const escapes = key === 'f11'
      || (input.alt && key === 'f4')
      || ((input.control || input.meta) && ['w', 'r'].includes(key))
      || ((input.control || input.meta) && input.shift && ['i', 'c', 'j'].includes(key))
    if (escapes) event.preventDefault()
  })

  // Leaving fullscreen by any route we did not predict simply gets undone.
  //
  // There is deliberately no blur -> focus handler here. Stealing focus back
  // would fight the native image picker Inventario opens, and alt-tabbing away
  // does not actually leave fullscreen: the register is still there, still
  // locked, when the cashier comes back.
  win.on('leave-full-screen', () => { if (locked) applyWindowLock() })

  applyWindowLock()
  applyShortcutLock()
}

function isLocked() {
  return locked
}

/** Whether this machine is a register at all, as opposed to right now. */
function isArmed() {
  return db.getSettings().kioskMode === '1'
}

/**
 * Arms or disarms the machine, and applies it now rather than at next launch.
 *
 * Two things move together here on purpose. `kioskMode` is the durable fact
 * that survives a restart; `locked` is the state of this session. Ticking the
 * box in Configuracion should visibly seal the window immediately, or the owner
 * has no way to tell whether it took — which is the whole risk of a lock that
 * is off by default.
 */
function setKioskMode(enabled) {
  db.setSetting('kioskMode', enabled ? '1' : '0')
  locked = Boolean(enabled)
  applyWindowLock()
  applyShortcutLock()
  return { ok: true, kioskMode: Boolean(enabled), locked }
}

/**
 * The only way out. Returns { ok } so the renderer learns yes or no and
 * nothing else — same contract as settings:verifyPassword.
 */
function unlock(password) {
  if (!locked) return { ok: true }
  if (!db.verifyPassword(password)) return { ok: false, error: 'Contraseña incorrecta' }
  locked = false
  applyWindowLock()
  applyShortcutLock()
  return { ok: true }
}

/**
 * TODO(you): decide the re-lock policy.
 *
 * Right now `unlock()` opens the register and leaves it open until someone
 * presses "Bloquear pantalla completa" in Configuracion -> Seguridad, or the
 * machine restarts. That is the permissive end of the trade-off.
 *
 * The alternative is a timer started in `unlock()` that calls `relock()` after
 * N minutes, so an owner who walks away mid-task does not leave the register
 * unlocked for the rest of the shift. It costs the owner a re-entry if a job
 * runs long, and it must not fire while a native dialog is open.
 *
 * Whichever you pick, it belongs here — the renderer must not be able to
 * postpone it.
 */

/** Puts the register back under the lock. Needs no password — sealing is safe. */
function relock() {
  locked = true
  applyWindowLock()
  applyShortcutLock()
  return { ok: true }
}

/** Closing has to go through here so `locked` can be cleared before `close`. */
function quit() {
  if (locked) return { ok: false, error: 'Bloqueado' }
  app.quit()
  return { ok: true }
}

function dispose() {
  globalShortcut.unregisterAll()
}

/**
 * Windows launch-on-login.
 *
 * setLoginItemSettings writes HKCU\...\Run, so it needs no admin rights and
 * survives without a scheduled task. Unpackaged (`electron .`) the executable
 * is electron.exe itself, which knows nothing about this project, so the app
 * directory has to be passed back as an argument.
 */
function setAutoStart(enabled) {
  if (process.platform !== 'win32') return { ok: false, error: 'Solo Windows' }

  // Packaged, process.execPath is the register's own .exe and needs no args.
  // Unpackaged it is electron.exe, which has to be told what to run.
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(app.getAppPath())],
  })
  return { ok: true, enabled: Boolean(enabled) }
}

function getAutoStart() {
  if (process.platform !== 'win32') return false
  return app.getLoginItemSettings().openAtLogin
}

module.exports = {
  attach, isLocked, isArmed, setKioskMode, unlock, relock, quit, dispose,
  setAutoStart, getAutoStart,
}
