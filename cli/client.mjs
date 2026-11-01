import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { CliError, readJson, writeJson } from './runtime.mjs'

/** Make a bounded API request using only a session scoped to this exact origin. */
export async function apiRequest(directory, base, route, method = 'GET', body) {
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\') || new URL(route, base).origin !== base)
    throw new CliError('API path must stay on the selected server origin.')
  const session = readJson(path.join(directory, 'cli-session.json'), null)
  const headers = { Origin: base, 'Content-Type': 'application/json' }
  if (session?.origin === base) headers.Cookie = session.cookie
  let response
  try {
    response = await fetch(new URL(route, base), {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  } catch (cause) {
    throw new CliError('Cannot reach the selected Doop server.', { cause })
  }
  if (!response.ok)
    throw new CliError(
      `Doop API returned HTTP ${response.status}.${response.status === 401 ? ' Run doop auth login.' : ''}`,
    )
  return response
}

async function credentials(values) {
  if (values['password-stdin']) {
    if (!values.email) throw new CliError('--password-stdin requires --email.')
    let text = ''
    for await (const chunk of process.stdin) {
      text += chunk
      if (text.length > 4096) throw new CliError('Password input is too long.')
    }
    return { email: values.email, password: text.replace(/\r?\n$/, '') }
  }
  if (!process.stdin.isTTY) throw new CliError('Use --email and --password-stdin for non-interactive login.')
  let muted = false
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk)
      callback()
    },
  })
  const prompt = createInterface({ input: process.stdin, output, terminal: true })
  try {
    const email = values.email || (await prompt.question('Email: '))
    process.stdout.write('Password: ')
    muted = true
    const password = await prompt.question('', { signal: AbortSignal.timeout(120_000) })
    process.stdout.write('\n')
    return { email, password }
  } finally {
    prompt.close()
  }
}

/** Manage local account sessions; passwords never enter argv or persistent files. */
export async function authCommand(action, directory, base, values) {
  const sessionFile = path.join(directory, 'cli-session.json')
  if (action === 'login') {
    const origin = new URL(base)
    if (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
      throw new CliError('Account login requires HTTPS except on loopback.')
    const input = await credentials(values)
    let response
    try {
      response = await fetch(base + '/api/auth/sign-in/email', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
    } catch (cause) {
      throw new CliError('Cannot reach the selected Doop server.', { cause })
    }
    if (!response.ok) throw new CliError(`Login failed (HTTP ${response.status}).`)
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    if (!cookie) throw new CliError('Server did not return a session cookie.')
    writeJson(sessionFile, { origin: base, cookie })
    return { authenticated: true, origin: base }
  }
  if (action === 'logout') {
    if (readJson(sessionFile, null)?.origin === base)
      await apiRequest(directory, base, '/api/auth/sign-out', 'POST', {})
    rmSync(sessionFile, { force: true })
    return { authenticated: false }
  }
  if (['status', 'list', 'whoami'].includes(action)) return (await apiRequest(directory, base, '/api/me')).json()
  throw new CliError('Unknown auth command. Use login, logout or status.')
}

/** Load literal JSON or a file body without putting its contents in errors. */
export function requestBody(value) {
  if (value === undefined) return undefined
  try {
    const text = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value
    JSON.parse(text)
    return text
  } catch (cause) {
    throw new CliError('Request body must be valid JSON, or @path to a JSON file.', { cause })
  }
}
