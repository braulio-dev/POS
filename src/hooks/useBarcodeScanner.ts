import { useEffect, useRef } from 'react'

/**
 * The Datalogic scanner on this machine enumerates as a plain HID keyboard
 * (VID_05F9/PID_2602, "HID Keyboard Device"), so the browser cannot tell its
 * keystrokes from the cashier's. The only signal available above the driver is
 * timing: the scanner emits its whole burst in a few milliseconds per character
 * and ends with Enter. Fingers cannot do that.
 */

const MAX_GAP_MS = 50
const MIN_LENGTH = 4

/**
 * A wedge scanner types into whatever has focus, so a scan taken while the
 * cashier's cursor sits in "Buscar" leaves the barcode sitting in the search
 * box. We can't stop the characters from landing (we only know it was a scan
 * once Enter arrives), so we undo it: strip the code back off the field.
 *
 * React tracks input values on the DOM node, so assigning `.value` directly is
 * invisible to it. Going through the prototype's native setter and then firing
 * an `input` event is what makes React's onChange actually see the change.
 */
function stripScannedText(code: string) {
  const el = document.activeElement
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
  if (!el.value.endsWith(code)) return

  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, el.value.slice(0, -code.length))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const buffer = useRef('')
  const lastKeyAt = useRef(0)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    if (!enabled) return

    function handleKey(e: KeyboardEvent) {
      const now = performance.now()
      // A slow keystroke ends whatever burst was in progress and starts fresh.
      if (now - lastKeyAt.current > MAX_GAP_MS) buffer.current = ''
      lastKeyAt.current = now

      if (e.key === 'Enter') {
        const code = buffer.current
        buffer.current = ''
        if (code.length >= MIN_LENGTH) {
          // Swallow the scanner's trailing Enter so it can't submit anything.
          e.preventDefault()
          e.stopPropagation()
          stripScannedText(code)
          onScanRef.current(code)
        }
        return
      }

      // Scanners emit plain printable characters; ignore modifiers and arrows.
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        buffer.current += e.key
      }
    }

    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [enabled])
}
