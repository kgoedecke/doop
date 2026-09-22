import { terminalCrypto } from './terminal-crypto.js'

// Self-contained browser entrypoint; the standard Edge bundle serves it inline.
// No separate frontend build, CDN, credential storage, or OAuth implementation.
export function loginClient(createCrypto: typeof terminalCrypto) {
  const transport = createCrypto()
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const tokenInput = element<HTMLInputElement>('token'),
    input = element<HTMLInputElement>('input')
  const start = element<HTMLButtonElement>('start'),
    cancel = element<HTMLButtonElement>('cancel'),
    send = element<HTMLButtonElement>('send')
  const status = element('status'),
    terminal = element('terminal'),
    links = element('links')
  let token = '',
    sessionId = '',
    attemptId = '',
    activeAttemptId = '',
    cursor = '',
    inputSequence = 0,
    outputSequence = 0
  let pair: Awaited<ReturnType<ReturnType<typeof terminalCrypto>['generate']>> | undefined, key: CryptoKey | undefined
  let connection: AbortController | undefined,
    finished = false,
    expiresAt = 0,
    outputText = '',
    connectionTask: Promise<void> | undefined
  const seenLinks = new Set<string>()
  const display = (text: string) => {
    status.textContent = text
  }
  const controls = (connected: boolean) => {
    input.disabled = !connected
    send.disabled = !connected
  }
  const fail = (text: string) => {
    display(text)
    controls(false)
  }
  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Request failed (${response.status}). Check your application access token.`)
    return response.json()
  }
  function render(text: string) {
    outputText = (outputText + text).slice(-64 * 1024)
    // Render only inert text. Terminal control sequences never become HTML.
    const clean = outputText
      // eslint-disable-next-line no-control-regex -- Strip or reject terminal control characters intentionally.
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex -- Strip or reject terminal control characters intentionally.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex -- Strip or reject terminal control characters intentionally.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    terminal.textContent = clean
    terminal.scrollTop = terminal.scrollHeight
    for (const candidate of clean.match(/https:\/\/[^\s<>"']+/g) ?? []) {
      try {
        const url = new URL(candidate)
        if (
          url.username ||
          url.password ||
          !['claude.ai', 'claude.com', 'anthropic.com'].some(
            (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
          ) ||
          seenLinks.has(url.href)
        )
          continue
        seenLinks.add(url.href)
        const a = document.createElement('a')
        a.href = url.href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.textContent = 'Open Anthropic sign-in'
        links.append(a)
      } catch {
        /* Not a complete URL yet. */
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Raw platform event envelopes include transport reset variants outside application events.
  async function event(value: any) {
    if (
      value.type === 'auth.reset' ||
      [value.type, value.code, value.error?.code].some(
        (code) => code === 'event_stream_reset' || code === 'event_cursor_expired',
      )
    )
      throw new Error('The login terminal was reset. Start a new attempt.')
    if (value.attemptId !== attemptId) return
    if (value.type === 'auth.started') {
      key = await transport.derive(pair!.privateKey, value.publicKey)
      activeAttemptId = attemptId
      expiresAt = value.expiresAt
      display('Open the Anthropic link below. Follow the native terminal prompts.')
      cancel.disabled = false
      controls(true)
    } else if (value.type === 'auth.output') {
      const sequence = value.terminalSequence
      if (sequence <= outputSequence) return
      if (!key || sequence !== outputSequence + 1)
        throw new Error('Terminal output was lost. Cancel this attempt and start again.')
      render(await transport.open(key, value, `${attemptId}:output:${sequence}`))
      outputSequence = sequence
    } else if (value.type === 'auth.finished') {
      finished = true
      controls(false)
      cancel.disabled = true
      start.disabled = false
      input.value = ''
      display(
        value.authenticated && value.outcome === 'succeeded'
          ? 'Claude is connected. You can now create agent sessions.'
          : `Login ${value.outcome}. You can start again.`,
      )
      key = undefined
      pair = undefined
    } else if (value.type === 'auth.error') {
      if (value.activeAttemptId) {
        activeAttemptId = value.activeAttemptId
        cancel.disabled = false
      }
      throw new Error(
        value.code === 'login_busy'
          ? 'Another login is active. Cancel it before starting again.'
          : `Login error: ${value.code}. Cancel and start again.`,
      )
    }
  }
  async function subscribe(controller: AbortController, onOpen: () => void) {
    while (!controller.signal.aborted && !finished) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await fetch(`/v1/events?sessionId=${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${token}`, ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!response.ok) {
          finished = true
          throw new Error(
            `Event stream unavailable (${response.status}). Reconnect with a valid application token or restart the login.`,
          )
        }
        reader = response.body!.getReader()
        onOpen()
        let buffer = ''
        const decoder = new TextDecoder()
        while (!finished) {
          const part = await reader.read()
          if (part.done) break
          buffer += decoder.decode(part.value, { stream: true })
          if (buffer.length > 256 * 1024) throw new Error('Invalid event stream')
          let match: RegExpExecArray | null
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index)
            buffer = buffer.slice(match.index + match[0].length)
            const lines = frame.split(/\r?\n/),
              id = lines
                .find((line) => line.startsWith('id:'))
                ?.slice(3)
                .trim()
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
            if (data) {
              try {
                await event(JSON.parse(data))
              } catch (error) {
                finished = true
                throw error
              }
            }
            if (id) cursor = id
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (finished) throw error
        display('Connection interrupted. Reconnecting…')
      } finally {
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
      if (!finished) {
        if (expiresAt && Date.now() > expiresAt + 15000) throw new Error('Login expired. Start again.')
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }
  element<HTMLFormElement>('connect').addEventListener('submit', async (e) => {
    e.preventDefault()
    if (start.disabled) return
    if (!tokenInput.value.trim() && !token) {
      fail('Enter your application access token.')
      return
    }
    token = tokenInput.value.trim() || token
    tokenInput.value = ''
    start.disabled = true
    controls(false)
    connection?.abort()
    await connectionTask?.catch(() => {})
    finished = false
    key = undefined
    cursor = ''
    inputSequence = 0
    outputSequence = 0
    outputText = ''
    terminal.textContent = ''
    links.replaceChildren()
    seenLinks.clear()
    attemptId = crypto.randomUUID()
    activeAttemptId = attemptId
    expiresAt = Date.now() + 10 * 60 * 1000
    try {
      pair = await transport.generate()
      display('Preparing your login terminal…')
      const prepared = await post('/v1/auth', {})
      sessionId = prepared.sessionId
      const controller = (connection = new AbortController())
      let opened!: () => void, openFailed!: (error: unknown) => void
      const ready = new Promise<void>((resolve, reject) => {
        opened = resolve
        openFailed = reject
      })
      connectionTask = subscribe(controller, opened).catch((error) => {
        openFailed(error)
        fail(error.message)
        start.disabled = false
      })
      // Connect before dispatching so the initial key and output cannot be missed.
      let openingTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            openingTimer = setTimeout(() => reject(new Error('Terminal connection timed out. Try again.')), 15000)
          }),
        ])
      } finally {
        clearTimeout(openingTimer)
      }
      await post('/v1/auth', { attemptId, publicKey: pair.publicKey })
      cancel.disabled = false
    } catch (error) {
      connection?.abort()
      start.disabled = false
      fail((error as Error).message)
    }
  })
  element<HTMLFormElement>('terminal-input').addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!key || send.disabled) return
    const text = input.value + '\r'
    input.value = ''
    send.disabled = true
    try {
      const sequence = inputSequence + 1,
        frame = await transport.seal(key, text, `${attemptId}:input:${sequence}`)
      // Never retry with a new sequence after an ambiguous network failure.
      await post('/v1/auth/input', { attemptId, sequence, ...frame })
      inputSequence = sequence
      send.disabled = finished || !key
      if (!send.disabled) input.focus()
    } catch {
      fail('Input delivery was interrupted. Cancel and start a new login attempt.')
    }
  })
  cancel.addEventListener('click', async () => {
    cancel.disabled = true
    controls(false)
    try {
      await post('/v1/auth/cancel', { attemptId: activeAttemptId })
      display('Cancellation requested. Wait for the terminal to finish.')
      // A busy attempt may belong to a previous tab whose private key is gone.
      if (activeAttemptId !== attemptId || finished) {
        connection?.abort()
        start.disabled = false
      }
    } catch {
      cancel.disabled = false
      fail('Could not cancel. Retry or wait for the ten-minute timeout.')
    }
  })
  window.addEventListener('pagehide', () => {
    connection?.abort()
    input.value = ''
    tokenInput.value = ''
    token = ''
    key = undefined
    pair = undefined
  })
}

export function loginPage(): Response {
  const nonce = crypto.randomUUID()
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Claude · Cantelop</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{font:16px system-ui,sans-serif;background:#f7f7f3;color:#252924;margin:0;padding:40px 20px}main{max-width:760px;margin:auto}h1{font-size:32px;letter-spacing:-1px}p{line-height:1.6;color:#596157}label{display:block;margin:16px 0 6px}input{width:100%;padding:12px;border:1px solid #b8c1b3;border-radius:6px;font:inherit}button{padding:11px 18px;background:#254b38;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer;margin:12px 8px 12px 0}button:disabled{opacity:.45;cursor:default}#cancel{background:#626862}pre{background:#18221b;color:#e2efdf;min-height:200px;max-height:400px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;border-radius:8px;font:13px/1.6 monospace}a{display:block;color:#255d3d;margin:12px 0}#status{min-height:26px;font-weight:600}small{color:#596157}</style>
<main><small>CANTELOP</small><h1>Connect your Claude subscription</h1><p>This opens Claude Code’s native login in your private workspace. Sign in on Anthropic’s website, then follow the terminal prompts below.</p>
<form id="connect"><label for="token">Application access token</label><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Token from your application’s sign-in"><button id="start">Connect Claude</button><button id="cancel" type="button" disabled>Cancel login</button></form>
<p id="status" role="status" aria-live="polite">Ready to connect.</p><div id="links"></div><pre id="terminal" aria-label="Claude Code login output"></pre>
<form id="terminal-input"><label for="input">Terminal input</label><input id="input" type="password" autocomplete="off" spellcheck="false" maxlength="2048" disabled aria-describedby="input-help"><small id="input-help">Only enter a code or response when Claude’s terminal requests it. Send an empty response to press Enter.</small><br><button id="send" disabled>Send to Claude</button></form>
<p><small>Login attempts expire after ten minutes. Keep this page open: temporary terminal keys are discarded when it closes. Browser reconnection works while this page remains open.</small></p></main>
<script nonce="${nonce}">(${loginClient.toString()})(${terminalCrypto.toString()});</script></html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      },
    },
  )
}
