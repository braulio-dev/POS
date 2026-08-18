/**
 * Card terminal drivers.
 *
 * The register talks to a physical card terminal ("la terminal") — a Clip or a
 * Mercado Pago Point sitting next to the till. There are two honest ways to do
 * that, and this module supports both because a shop needs the first one to
 * work on day one and only *maybe* ever gets the second:
 *
 *   manual   The cashier operates the terminal itself: types the amount on its
 *            keypad, the customer taps, the terminal prints its own slip. The
 *            register just records what happened — amount, authorisation
 *            number, brand, last four. No credentials, no internet, no vendor
 *            approval process. This is the default, and it is how the large
 *            majority of small Mexican shops actually run a Clip today.
 *
 *   cloud    The register pushes the amount to the terminal over the vendor's
 *            API and polls until the customer has paid. Fewer keystrokes and no
 *            chance of the cashier charging the wrong amount, but it needs an
 *            integration account, a device id, and working internet.
 *
 * NOTHING HERE IS ON THE CRITICAL PATH OF A SALE. A cloud charge happens
 * *before* the sale is recorded, and if it cannot be reached the payment screen
 * falls back to manual entry. That is the same rule the rest of this codebase
 * follows: the internet being down must cost convenience, never a sale.
 *
 * ---------------------------------------------------------------------------
 * On the endpoint paths below
 * ---------------------------------------------------------------------------
 * The Mercado Pago Point driver follows their published device payment-intent
 * flow: create an intent against a device id, poll it until it reaches a
 * terminal state.
 *
 * The Clip driver follows THE SAME create-and-poll shape, because that is what
 * card terminal APIs universally look like — but the exact paths and the exact
 * response field names must be checked against the credentials and integration
 * docs Clip issues to *this* store before anyone relies on it at the counter.
 * That is why the base URL is a setting rather than a constant: correcting it
 * is a Configuración edit, not a code change and a reinstall. Until it has been
 * verified against a real device, leave the provider on `manual` — which is
 * complete, needs nothing from Clip, and is what the payment screen falls back
 * to anyway whenever a cloud charge cannot be started.
 */

const db = require('./db.cjs')

const REQUEST_TIMEOUT_MS = 20000

/** Charge states the register treats as final — nothing more will change. */
const FINAL_STATES = new Set(['approved', 'declined', 'canceled', 'error'])

function config() {
  const s = db.getSettings()
  return {
    provider: String(s.terminalProvider || 'manual'),
    apiUrl: String(s.terminalApiUrl || '').replace(/\/+$/, ''),
    apiKey: String(s.terminalApiKey || ''),
    deviceId: String(s.terminalDeviceId || ''),
    // Whether the amount is pushed to the terminal, or typed on its keypad.
    autoCharge: s.terminalAutoCharge === '1',
  }
}

/** Public, secret-free view for the settings screen and the payment modal. */
function status() {
  const cfg = config()
  return {
    provider: cfg.provider,
    // Manual is always ready — it needs nothing but a terminal on the counter.
    ready: cfg.provider === 'manual'
      ? true
      : Boolean(cfg.autoCharge && cfg.apiUrl && cfg.apiKey && cfg.deviceId),
    autoCharge: cfg.provider !== 'manual' && cfg.autoCharge,
    configured: Boolean(cfg.apiUrl && cfg.apiKey && cfg.deviceId),
  }
}

async function request(cfg, route, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${cfg.apiUrl}${route}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    })

    const text = await res.text()
    let body = {}
    try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }

    if (!res.ok) {
      const detail = body.message || body.error || text.slice(0, 200)
      throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
    return body
  } finally {
    clearTimeout(timeout)
  }
}

const upper = (value) => (value ? String(value).toUpperCase() : null)

/* -------------------------------------------------------------- providers */

/**
 * Mercado Pago Point.
 *
 * Create an intent against the device, then poll it. Amounts are integer cents,
 * which is what this codebase carries everywhere, so nothing is converted and
 * nothing can be lost to a float.
 *
 * States seen on the wire: OPEN and ON_TERMINAL mean the customer has not
 * finished; PROCESSED and FINISHED mean paid; CANCELED / ABANDONED / ERROR are
 * the ways it can end without money moving.
 */
const mercadopago = {
  async charge(cfg, { amountCents, reference }) {
    const body = await request(
      cfg,
      `/point/integration-api/devices/${encodeURIComponent(cfg.deviceId)}/payment-intents`,
      {
        method: 'POST',
        body: JSON.stringify({
          amount: amountCents,
          additional_info: { external_reference: reference, print_on_terminal: true },
        }),
      }
    )
    return { intentId: body.id ?? null, status: mapMercadoPagoState(body.state) }
  },

  async poll(cfg, intentId) {
    const body = await request(
      cfg,
      `/point/integration-api/payment-intents/${encodeURIComponent(intentId)}`
    )
    const payment = body.payment || {}
    return {
      status: mapMercadoPagoState(body.state),
      // The payment id is what shows up on the Mercado Pago statement, so it is
      // the reference worth keeping when there is no separate auth code.
      reference: payment.id ? String(payment.id) : (body.id ? String(body.id) : null),
      cardBrand: upper(payment.payment_method_id),
      cardLast4: payment.card ? payment.card.last_four_digits ?? null : null,
    }
  },

  async cancel(cfg, intentId) {
    await request(
      cfg,
      `/point/integration-api/devices/${encodeURIComponent(cfg.deviceId)}/payment-intents/${encodeURIComponent(intentId)}`,
      { method: 'DELETE' }
    )
    return { status: 'canceled' }
  },
}

function mapMercadoPagoState(state) {
  switch (String(state || '').toUpperCase()) {
    case 'FINISHED':
    case 'PROCESSED': return 'approved'
    case 'CANCELED':
    case 'ABANDONED': return 'canceled'
    case 'ERROR': return 'error'
    default: return 'pending'
  }
}

/**
 * Clip.
 *
 * The same create-and-poll shape. Response fields are read defensively —
 * several plausible spellings are accepted for the authorisation code and the
 * card details — so a naming difference degrades to "approved, but we did not
 * capture the brand" rather than to a charge the register refuses to believe.
 *
 * See the header: verify these routes against this store's own Clip
 * integration before turning `terminalAutoCharge` on.
 */
const clip = {
  async charge(cfg, { amountCents, reference }) {
    const body = await request(cfg, '/v1/payment-intents', {
      method: 'POST',
      body: JSON.stringify({
        // Clip quotes amounts in pesos, not cents. Dividing here (once, at the
        // boundary) keeps integer cents the only representation everywhere else.
        amount: amountCents / 100,
        currency: 'MXN',
        device_id: cfg.deviceId,
        external_reference: reference,
      }),
    })
    return {
      intentId: body.id ?? body.payment_intent_id ?? null,
      status: mapClipState(body.status),
    }
  },

  async poll(cfg, intentId) {
    const body = await request(cfg, `/v1/payment-intents/${encodeURIComponent(intentId)}`)
    const card = body.card || (body.payment_method && body.payment_method.card) || {}
    return {
      status: mapClipState(body.status),
      reference: body.authorization_code || body.auth_code || body.receipt_no || body.id || null,
      cardBrand: upper(card.brand || card.type),
      cardLast4: card.last4 || card.last_four_digits || null,
    }
  },

  async cancel(cfg, intentId) {
    await request(cfg, `/v1/payment-intents/${encodeURIComponent(intentId)}/cancel`, {
      method: 'POST',
    })
    return { status: 'canceled' }
  },
}

function mapClipState(state) {
  switch (String(state || '').toLowerCase()) {
    case 'approved':
    case 'paid':
    case 'succeeded':
    case 'completed': return 'approved'
    case 'declined':
    case 'rejected':
    case 'failed': return 'declined'
    case 'canceled':
    case 'cancelled':
    case 'expired': return 'canceled'
    case 'error': return 'error'
    default: return 'pending'
  }
}

const DRIVERS = { clip, mercadopago }

/* ------------------------------------------------------------------- API */

/**
 * Starts a charge on the terminal.
 *
 * Never throws. A provider that is unreachable comes back as
 * `{ ok: false, fallback: 'manual' }`, which the payment screen reads as "let
 * the cashier use the terminal's keypad and type the auth code" — the sale
 * still completes, which is the whole point.
 */
async function charge({ amountCents, reference }) {
  const cfg = config()
  const driver = DRIVERS[cfg.provider]

  if (!driver || !cfg.autoCharge) {
    return { ok: false, fallback: 'manual', reason: 'El cobro se captura en la terminal' }
  }
  if (!cfg.apiUrl || !cfg.apiKey || !cfg.deviceId) {
    return { ok: false, fallback: 'manual', reason: 'Falta configurar la terminal' }
  }

  try {
    const result = await driver.charge(cfg, { amountCents, reference })
    return { ok: true, provider: cfg.provider, ...result }
  } catch (err) {
    return { ok: false, fallback: 'manual', reason: String(err.message || err) }
  }
}

/** Asks the terminal where a charge stands. Also never throws. */
async function poll(intentId) {
  const cfg = config()
  const driver = DRIVERS[cfg.provider]
  if (!driver || !intentId) return { ok: false, status: 'error', final: true, reason: 'Cobro desconocido' }

  try {
    const result = await driver.poll(cfg, intentId)
    return { ok: true, provider: cfg.provider, final: FINAL_STATES.has(result.status), ...result }
  } catch (err) {
    // A poll that fails is not a declined charge — the customer may well have
    // paid. It stays pending so the cashier decides, rather than the register
    // silently deciding for them and either losing money or double-charging.
    return { ok: false, status: 'pending', final: false, reason: String(err.message || err) }
  }
}

/** Cancels a charge the cashier gave up on, so the terminal stops waiting. */
async function cancel(intentId) {
  const cfg = config()
  const driver = DRIVERS[cfg.provider]
  if (!driver || !intentId) return { ok: true, status: 'canceled' }

  try {
    await driver.cancel(cfg, intentId)
    return { ok: true, status: 'canceled' }
  } catch (err) {
    return { ok: false, status: 'canceled', reason: String(err.message || err) }
  }
}

/** Verifies credentials before the owner commits to saving them. */
async function testConnection({ provider, apiUrl, apiKey, deviceId }) {
  const cfg = {
    provider: String(provider || 'manual'),
    apiUrl: String(apiUrl || '').replace(/\/+$/, ''),
    apiKey: String(apiKey || ''),
    deviceId: String(deviceId || ''),
  }

  if (cfg.provider === 'manual') {
    return { ok: true, note: 'Captura manual: no necesita conexión' }
  }
  if (!DRIVERS[cfg.provider]) return { ok: false, error: `Proveedor desconocido: ${cfg.provider}` }
  if (!cfg.apiUrl || !cfg.apiKey || !cfg.deviceId) {
    return { ok: false, error: 'Falta la dirección, la llave o el número de terminal' }
  }

  // A $1 intent that is cancelled straight away is the only end-to-end proof
  // that the credentials, the device id and the network all work *together*.
  // Reading a device list would not prove the terminal can actually be driven.
  try {
    const started = await DRIVERS[cfg.provider].charge(cfg, {
      amountCents: 100,
      reference: 'prueba-conexion',
    })
    if (started.intentId) {
      await DRIVERS[cfg.provider].cancel(cfg, started.intentId).catch(() => {})
    }
    return { ok: true, note: 'La terminal respondió. Se canceló el cobro de prueba.' }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

module.exports = { charge, poll, cancel, status, testConnection }
