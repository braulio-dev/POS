const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const escpos = require('./escpos.cjs')

const PS = 'powershell.exe'

/**
 * Path to the spooler script, as PowerShell can see it.
 *
 * Packaged, the app lives inside app.asar — a virtual archive that only Node's
 * patched fs understands. powershell.exe is an outside process and cannot read
 * a path through it, so the script is listed under asarUnpack in
 * electron-builder.yml and extracted to app.asar.unpacked alongside it.
 * __dirname still reports the archive path, so it is rewritten here.
 *
 * Unpackaged the replace matches nothing and the path is used as-is.
 */
const SCRIPT = path
  .join(__dirname, '..', 'scripts', 'raw-print.ps1')
  .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)

function runPowerShell(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message))
        resolve(stdout.trim())
      }
    )
  })
}

/** Names of installed printers, so the settings screen isn't a text field. */
async function listPrinters() {
  const out = await runPowerShell([
    '-Command',
    '(Get-Printer | Select-Object -ExpandProperty Name) -join "`n"',
  ])
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * Spools a raw ESC/POS payload. The bytes go via a temp file because command
 * lines mangle binary data; the file is removed whether or not printing worked.
 */
async function printRaw(printerName, bytes, docName = 'Ticket') {
  const tmp = path.join(os.tmpdir(), `pos-${crypto.randomUUID()}.bin`)
  fs.writeFileSync(tmp, bytes)
  try {
    await runPowerShell([
      '-File', SCRIPT,
      '-PrinterName', printerName,
      '-FilePath', tmp,
      '-DocName', docName,
    ])
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

const printReceipt = (printerName, sale, storeName) =>
  printRaw(printerName, escpos.buildReceipt(sale, storeName), 'Ticket de venta')

const printTestPage = (printerName) =>
  printRaw(printerName, escpos.buildTestPage(), 'Prueba de impresora')

const printCorte = (printerName, corte, storeName) =>
  printRaw(printerName, escpos.buildCorte(corte, storeName), 'Corte de caja')

module.exports = { listPrinters, printRaw, printReceipt, printTestPage, printCorte }
