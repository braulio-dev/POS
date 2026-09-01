import { useEffect, useRef, useState } from 'react'
import { pos } from '../lib/api'

interface Props {
  onUnlock: () => void
  onCancel: () => void
  /** Defaults to the Configuracion wording this started life as. */
  title?: string
  note?: string
  confirmLabel?: string
  /**
   * How the answer gets checked. Defaults to settings:verifyPassword, but the
   * kiosk gate passes kioskUnlock instead: unlocking the window is a decision
   * only the main process may take, so it cannot be a verify-then-act here.
   */
  verify?: (password: string) => Promise<boolean | { ok: boolean; error?: string }>
}

/**
 * Gate in front of Configuración, and — with `verify` — in front of leaving
 * kiosk mode.
 *
 * The threat here is a curious or annoyed cashier changing prices, not a
 * determined attacker — but the check still runs in the main process, so a
 * wrong answer is the only thing this component can ever learn.
 */
export function PasswordPrompt({
  onUnlock,
  onCancel,
  title = 'Configuración',
  note = 'Ingresa la contraseña para continuar.',
  confirmLabel = 'ENTRAR',
  verify,
}: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function submit() {
    if (checking) return
    setChecking(true)
    const result = verify ? await verify(password) : await pos.verifyPassword(password)
    const ok = typeof result === 'boolean' ? result : result.ok
    if (ok) {
      onUnlock()
      return
    }
    setError((typeof result === 'object' && result.error) || 'Contraseña incorrecta')
    setPassword('')
    setChecking(false)
    inputRef.current?.focus()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal password-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        <p className="muted-note">{note}</p>

        <label className="field">
          <span>CONTRASEÑA</span>
          <input
            ref={inputRef}
            className="text-input"
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </label>

        {error && <p className="field-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancelar</button>
          <button className="btn-cobrar" onClick={submit} disabled={checking}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
