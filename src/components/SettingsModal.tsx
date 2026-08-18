import { useEffect, useState } from 'react'
import type { CorteRow, MaintenanceStatus, Settings, SyncStatus } from '../types'
import { formatMoney, parseAmount } from '../lib/money'
import { pos } from '../lib/api'

type Tab = 'general' | 'impresora' | 'corte' | 'sync' | 'respaldos' | 'seguridad'

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'impresora', label: 'Impresora' },
  { id: 'corte', label: 'Corte' },
  { id: 'sync', label: 'Sincronización' },
  { id: 'respaldos', label: 'Respaldos' },
  { id: 'seguridad', label: 'Seguridad' },
]

interface Props {
  /**
   * Fires on every saved change, not just on close. That is what keeps the
   * header in step with the store name as it is typed — the modal is not the
   * owner of that value, App is.
   */
  onSettingsChange: (settings: Settings) => void
  onClose: () => void
}

/** 57344 -> "56 KB". Backups are the one place raw byte counts help nobody. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function everyPhrase(ms: number): string {
  if (ms % 86400000 === 0) return `cada ${ms / 86400000} día(s)`
  if (ms % 3600000 === 0) return `cada ${ms / 3600000} h`
  if (ms % 60000 === 0) return `cada ${ms / 60000} min`
  return `cada ${Math.round(ms / 1000)} s`
}

function when(iso: string | null): string {
  if (!iso) return 'nunca'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'nunca'
  return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
}

export function SettingsModal({ onSettingsChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('general')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [printers, setPrinters] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  // Money and credentials are edited as drafts and committed on blur. Saving a
  // partially typed URL on every keystroke would re-arm the sync worker dozens
  // of times, and "20." is not a number yet.
  const [thresholdDraft, setThresholdDraft] = useState('')
  const [cortes, setCortes] = useState<CorteRow[]>([])
  const [sync, setSync] = useState<SyncStatus | null>(null)

  const [maint, setMaint] = useState<MaintenanceStatus | null>(null)
  const [maintError, setMaintError] = useState<string | null>(null)

  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwStatus, setPwStatus] = useState<string | null>(null)

  useEffect(() => {
    pos.getSettings().then((s) => {
      setSettings(s)
      setThresholdDraft(formatMoney(Number(s.corteThresholdCents) || 0).replace('$', ''))
    })
    // Enumerating printers takes a moment (it shells out), so the dropdown
    // fills in after the modal is already on screen rather than delaying it.
    pos.listPrinters().then(setPrinters).catch(() => setPrinters([]))
    pos.listCortes(10).then(setCortes).catch(() => setCortes([]))
    pos.getSyncStatus().then(setSync).catch(() => setSync(null))

    // The worker pushes its own updates, so a sync running in the background
    // shows up here without this screen polling for it.
    return pos.onSyncStatus(setSync)
  }, [])

  async function update(key: keyof Settings, value: string) {
    const next = await pos.setSetting(key, value)
    setSettings(next)
    onSettingsChange(next)
    setStatus(null)
  }

  async function testPrint() {
    if (!settings) return
    setTesting(true)
    setStatus('Enviando…')
    const result = await pos.testPrinter(settings.printerName)
    setStatus(
      result.ok
        ? 'Enviado a la impresora. Si no salió papel, revisa que esté encendida y conectada.'
        : `Error: ${result.error}`
    )
    setTesting(false)
  }

  async function testSync() {
    if (!settings) return
    setTesting(true)
    setStatus('Conectando…')
    const result = await pos.testSync({
      url: settings.syncUrl, key: settings.syncKey, storeId: settings.syncStoreId,
    })
    setStatus(result.ok ? `Conectado con ${result.server}.` : `Error: ${result.error}`)
    setTesting(false)
  }

  async function syncNow() {
    setTesting(true)
    setStatus('Sincronizando…')
    const result = await pos.syncNow()
    setStatus(
      result.ok
        ? `Listo. Enviados ${result.pushed ?? 0}, recibidos ${result.applied ?? 0}, fotos ↑${result.uploaded ?? 0} ↓${result.downloaded ?? 0}.`
        : `Error: ${result.error}`
    )
    setSync(await pos.getSyncStatus())
    setTesting(false)
  }

  async function loadMaintenance() {
    const result = await pos.getMaintenance()
    if (result.ok && result.status) {
      setMaint(result.status)
      setMaintError(null)
    } else {
      setMaint(null)
      setMaintError(result.error ?? 'No se pudo consultar el servidor')
    }
  }

  async function backupNow() {
    setTesting(true)
    setStatus('Respaldando…')
    const result = await pos.runBackup()
    setStatus(result.ok ? `Respaldo creado: ${result.backup?.name}` : `Error: ${result.error}`)
    await loadMaintenance()
    setTesting(false)
  }

  async function changePassword() {
    const result = await pos.setPassword(currentPw, newPw)
    setPwStatus(result.ok ? 'Contraseña actualizada.' : `Error: ${result.error}`)
    if (result.ok) {
      setCurrentPw('')
      setNewPw('')
    }
  }

  if (!settings) return null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Configuración</h2>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className="settings-tab"
              onClick={() => {
                setTab(t.id)
                setStatus(null)
                // Fetched on demand: it is a network round trip to the server,
                // and most visits to Configuración never open this tab.
                if (t.id === 'respaldos') loadMaintenance()
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'general' && (
            <label className="field">
              <span>NOMBRE DE LA TIENDA</span>
              <input
                className="text-input"
                value={settings.storeName}
                onChange={(e) => update('storeName', e.target.value)}
              />
              <span className="muted-note">Aparece en el encabezado y en los tickets.</span>
            </label>
          )}

          {tab === 'impresora' && (
            <>
              <label className="field">
                <span>IMPRESORA DE TICKETS</span>
                <select
                  className="text-input"
                  value={settings.printerName}
                  onChange={(e) => update('printerName', e.target.value)}
                >
                  {/* The saved printer stays listed even if it's unplugged, so an
                      offline printer never silently resets the setting. */}
                  {!printers.includes(settings.printerName) && (
                    <option value={settings.printerName}>{settings.printerName} (no encontrada)</option>
                  )}
                  {printers.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={settings.autoPrint === '1'}
                  onChange={(e) => update('autoPrint', e.target.checked ? '1' : '0')}
                />
                <span>Imprimir ticket automáticamente al cobrar</span>
              </label>

              <div className="modal-actions">
                <button className="btn-secondary" onClick={testPrint} disabled={testing}>
                  Imprimir prueba
                </button>
              </div>
            </>
          )}

          {tab === 'corte' && (
            <>
              <label className="field">
                <span>AVISAR AL LLEGAR A</span>
                <input
                  className="text-input"
                  inputMode="decimal"
                  value={thresholdDraft}
                  onChange={(e) => setThresholdDraft(e.target.value)}
                  onBlur={() => {
                    const cents = parseAmount(thresholdDraft)
                    if (cents === null || cents < 0) {
                      // Reject silently by snapping back — a half-typed amount
                      // must never become the live threshold.
                      setThresholdDraft(formatMoney(Number(settings.corteThresholdCents) || 0).replace('$', ''))
                      return
                    }
                    update('corteThresholdCents', String(cents))
                    setThresholdDraft(formatMoney(cents).replace('$', ''))
                  }}
                />
                <span className="muted-note">
                  Efectivo acumulado en caja antes de pedir un corte. Pon 0 para desactivar el aviso.
                </span>
              </label>

              <label className="field">
                <span>AVISAR CUANDO QUEDEN</span>
                <input
                  className="text-input"
                  type="number"
                  min="0"
                  step="1"
                  value={settings.lowStockThreshold}
                  onChange={(e) => update('lowStockThreshold', e.target.value)}
                />
                <span className="muted-note">Unidades o menos para marcar un producto como escaso.</span>
              </label>

              <div className="field">
                <span>ÚLTIMOS CORTES</span>
                {cortes.length === 0 ? (
                  <p className="muted-note">Todavía no se ha hecho ningún corte.</p>
                ) : (
                  <ul className="corte-list">
                    {cortes.map((c) => (
                      <li key={c.uuid}>
                        <span>{when(c.created_at)}</span>
                        <span className="muted-note">{c.sale_count} ventas</span>
                        <strong>{formatMoney(c.total_cents)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {tab === 'sync' && (
            <>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={settings.syncEnabled === '1'}
                  onChange={(e) => update('syncEnabled', e.target.checked ? '1' : '0')}
                />
                <span>Sincronizar con el servidor</span>
              </label>

              <label className="field">
                <span>DIRECCIÓN DEL SERVIDOR</span>
                <input
                  className="text-input"
                  placeholder="https://tuservidor.com:8787"
                  defaultValue={settings.syncUrl}
                  onBlur={(e) => update('syncUrl', e.target.value.trim())}
                />
              </label>

              <label className="field">
                <span>CLAVE</span>
                <input
                  className="text-input"
                  type="password"
                  placeholder="POS_SYNC_KEY"
                  defaultValue={settings.syncKey}
                  onBlur={(e) => update('syncKey', e.target.value.trim())}
                />
              </label>

              <div className="field-row">
                <label className="field">
                  <span>NOMBRE DE ESTA CAJA</span>
                  <input
                    className="text-input"
                    defaultValue={settings.syncStoreId}
                    onBlur={(e) => update('syncStoreId', e.target.value.trim() || 'principal')}
                  />
                </label>
                <label className="field">
                  <span>CADA (SEGUNDOS)</span>
                  <input
                    className="text-input"
                    type="number"
                    min="15"
                    step="5"
                    defaultValue={settings.syncIntervalSec}
                    onBlur={(e) => update('syncIntervalSec', e.target.value)}
                  />
                </label>
              </div>

              {sync && (
                <dl className="sync-status">
                  <div><dt>Estado</dt><dd>{sync.running ? 'Sincronizando…' : sync.enabled ? 'Activa' : 'Apagada'}</dd></div>
                  <div><dt>Sin enviar</dt><dd>{sync.pending}</dd></div>
                  <div><dt>Última vez</dt><dd>{when(sync.lastSyncAt)}</dd></div>
                  {sync.lastError && (
                    <div><dt>Último error</dt><dd className="sync-error">{sync.lastError}</dd></div>
                  )}
                </dl>
              )}

              <p className="muted-note">
                Las ventas se guardan siempre en esta computadora, con o sin internet.
                La sincronización sólo las copia al servidor y trae los cambios que
                hagas desde otro lado (precios, productos nuevos, fotos).
              </p>

              <div className="modal-actions">
                <button className="btn-secondary" onClick={testSync} disabled={testing}>Probar conexión</button>
                <button className="btn-secondary" onClick={syncNow} disabled={testing}>Sincronizar ahora</button>
              </div>
            </>
          )}

          {tab === 'respaldos' && (
            <>
              <p className="muted-note">
                Los respaldos se guardan en el servidor, no en esta computadora —
                de eso se trata: sobreviven aunque la caja se descomponga o se la roben.
              </p>

              {maintError && (
                <p className="settings-status sync-error">
                  {maintError}
                  <br />
                  Revisa la pestaña Sincronización.
                </p>
              )}

              {maint && (
                <>
                  <dl className="sync-status">
                    <div>
                      <dt>Respaldo automático</dt>
                      <dd>{maint.backupEnabled ? everyPhrase(maint.backupIntervalMs) : 'apagado'}</dd>
                    </div>
                    <div><dt>Último respaldo</dt><dd>{when(maint.lastBackupAt)}</dd></div>
                    <div><dt>Se conservan</dt><dd>{maint.backupKeep} copias</dd></div>
                    <div><dt>Tamaño de la base</dt><dd>{size(maint.databaseBytes)}</dd></div>
                    <div>
                      <dt>Limpieza automática</dt>
                      <dd>
                        {maint.purgeEnabled
                          ? `ventas de más de ${maint.purgeDays} días`
                          : 'apagada'}
                      </dd>
                    </div>
                    {maint.lastPurgeAt && (
                      <div><dt>Última limpieza</dt><dd>{when(maint.lastPurgeAt)}</dd></div>
                    )}
                    {maint.lastBackupError && (
                      <div><dt>Último error</dt><dd className="sync-error">{maint.lastBackupError}</dd></div>
                    )}
                  </dl>

                  <div className="field">
                    <span>COPIAS EN EL SERVIDOR</span>
                    {maint.backups.length === 0 ? (
                      <p className="muted-note">Todavía no hay respaldos.</p>
                    ) : (
                      <ul className="backup-list">
                        {maint.backups.map((b) => (
                          <li key={b.name}>
                            <span className="backup-when">{when(b.createdAt)}</span>
                            <span className="muted-note backup-name" title={b.name}>{b.name}</span>
                            <strong>{size(b.bytes)}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}

              <div className="modal-actions">
                <button className="btn-secondary" onClick={loadMaintenance} disabled={testing}>
                  Actualizar
                </button>
                <button className="btn-secondary" onClick={backupNow} disabled={testing}>
                  Respaldar ahora
                </button>
              </div>
            </>
          )}

          {tab === 'seguridad' && (
            <>
              <label className="field">
                <span>CONTRASEÑA ACTUAL</span>
                <input
                  className="text-input"
                  type="password"
                  value={currentPw}
                  onChange={(e) => { setCurrentPw(e.target.value); setPwStatus(null) }}
                />
              </label>

              <label className="field">
                <span>NUEVA CONTRASEÑA</span>
                <input
                  className="text-input"
                  type="password"
                  value={newPw}
                  onChange={(e) => { setNewPw(e.target.value); setPwStatus(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') changePassword() }}
                />
                <span className="muted-note">Mínimo 4 caracteres. De fábrica es 1234.</span>
              </label>

              {pwStatus && <p className="settings-status">{pwStatus}</p>}

              <div className="modal-actions">
                <button className="btn-secondary" onClick={changePassword} disabled={!currentPw || !newPw}>
                  Cambiar contraseña
                </button>
              </div>
            </>
          )}
        </div>

        {status && <p className="settings-status">{status}</p>}

        <div className="modal-actions">
          <button className="btn-cobrar" onClick={onClose}>LISTO</button>
        </div>
      </div>
    </div>
  )
}
