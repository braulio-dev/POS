interface Props {
  storeName: string
  onOpenSettings: () => void
  onOpenInventory: () => void
  onOpenTickets: () => void
  onOpenCash: () => void
  /** Shown on the cash button while the period has movements to explain. */
  movementCount: number
}

export function Header({
  storeName, onOpenSettings, onOpenInventory, onOpenTickets, onOpenCash, movementCount,
}: Props) {
  return (
    <header className="header">
      <button className="icon-btn" onClick={onOpenSettings} aria-label="Configuración" title="Configuración">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
        </svg>
      </button>
      {/* The store name is a setting, so it renders from state — editing it in
          Configuración repaints this title on the next keystroke. It sits in
          the flow next to the gear rather than centred, so a long name pushes
          nothing around: the spacer below absorbs the slack. */}
      <h1 className="store-title">{storeName}</h1>
      <span className="header-spacer" />

      {/* Tickets and caja are cashier tools and carry no password: reprinting a
          slip changes no money, and a salida happens whether or not the owner
          is in the shop — locking it would only stop it being written down. */}
      <button className="icon-btn" onClick={onOpenTickets} aria-label="Tickets" title="Tickets recientes">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" strokeLinecap="round" />
        </svg>
      </button>

      <button className="icon-btn" onClick={onOpenCash} aria-label="Entradas y salidas" title="Entradas y salidas de efectivo">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <rect x="2.5" y="6" width="19" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.6" />
        </svg>
        {/* Only when there is something to explain at the corte. */}
        {movementCount > 0 && <span className="icon-badge">{movementCount}</span>}
      </button>

      {/* Inventory sits behind the same password as Configuración: changing
          what the shelf says it holds is an owner action, not a cashier one. */}
      <button className="icon-btn" onClick={onOpenInventory} aria-label="Inventario" title="Inventario">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
          <path d="M3 7.5 12 12l9-4.5M12 12v9" />
        </svg>
      </button>
    </header>
  )
}
