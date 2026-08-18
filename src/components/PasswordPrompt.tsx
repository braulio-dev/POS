import { useEffect, useRef, useState } from 'react'
import { pos } from '../lib/api'

interface Props {
  onUnlock: () => void
  onCancel: () => void
}

/**
 * Gate in front of Configuración.
 *
 * The threat here is a curious or annoyed cashier changing prices, not a
 * determined attacker — but the check still runs in the main process, so a
 * wrong answer is the only thing this component can ever learn.
 */
export function PasswordPrompt({ onUnlock, onCancel }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function submit() {
    if (checking) return
    setChecking(true)
    const ok = await pos.verifyPassword(password)
    if (ok) {
      onUnlock()
      return
    }
    setError('Contraseña incorrecta')
    setPassword('')
    setChecking(false)
    inputRef.current?.focus()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal password-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Configuración</h2>
        <p className="muted-note">Ingresa la contraseña para continuar.</p>

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
          <button className="btn-cobrar" onClick={submit} disabled={checking}>ENTRAR</button>
        </div>
      </div>
    </div>
  )
}
