import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export async function optionalFile(path) {
  return readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
}

export function httpsOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a public HTTPS origin, such as https://doop.example.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Enter a public HTTPS origin without a path, credentials, query, or fragment.')
  return url.origin
}

export function updateEnv(source, values) {
  const remaining = { ...values }
  // Consume complete quoted assignments so multiline values are not mistaken for new variables.
  const next = source.replace(
    /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\r\n]*)[^\r\n]*/gm,
    (assignment, name) => {
      if (!(name in values)) return assignment
      delete remaining[name]
      return envLine(name, values[name])
    },
  )
  return `${next.trimEnd()}\n${Object.entries(remaining)
    .map(([key, value]) => envLine(key, value))
    .join('\n')}\n`
}

function envLine(name, value) {
  if (/[\r\n']/.test(value))
    throw new Error(`Cannot safely serialize ${name}; use a single-line value without apostrophes.`)
  return `${name}='${value}'`
}

async function privateWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function readSetup(root) {
  const service = join(root, 'cantelop')
  const source = await optionalFile(join(root, '.env'))
  const local = await optionalFile(join(service, 'cantelop.local.json'))
  const env = parseEnv(source)
  const app = local
    ? JSON.parse(local).app
    : /^https:\/\/([a-z0-9-]+)\.cantelop\.dev\/?$/.exec(env.CLAUDE_REMOTE_URL ?? '')?.[1]
  return { root, service, source, env, app }
}

export async function prepareSetup(root, { app, mcpOrigin }) {
  if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(app ?? ''))
    throw new Error(
      'App name must be 3–63 lowercase letters, digits, or hyphens, starting with a letter and ending with a letter or digit.',
    )
  const current = await readSetup(root)
  if (current.app && current.app !== app)
    throw new Error(
      `This checkout is already paired with ${current.app}. Use a separate checkout for another deployment.`,
    )
  const origin = `https://${app}.cantelop.dev`
  if (current.env.CLAUDE_REMOTE_URL && httpsOrigin(current.env.CLAUDE_REMOTE_URL) !== origin)
    throw new Error(
      'The existing CLAUDE_REMOTE_URL belongs to another deployment. Keep its configuration or use a separate checkout.',
    )
  if (mcpOrigin) mcpOrigin = httpsOrigin(mcpOrigin)
  const names = ['CLAUDE_REMOTE_SIGNING_KEY', 'CLAUDE_REMOTE_ISSUER', 'CLAUDE_REMOTE_AUDIENCE']
  const present = names.filter((name) => current.env[name])
  if (present.length && present.length !== names.length)
    throw new Error(
      'Existing Claude identity is incomplete. Restore its signing key, issuer, and audience before setup; they will not be replaced.',
    )
  const key = present.length
    ? createPrivateKey(current.env.CLAUDE_REMOTE_SIGNING_KEY.replace(/\\n/g, '\n'))
    : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('Existing signing key must be an ES256/P-256 key.')
  const issuer = current.env.CLAUDE_REMOTE_ISSUER || `urn:doop:${randomUUID()}`
  const audience = current.env.CLAUDE_REMOTE_AUDIENCE || app
  const doop = {
    CLAUDE_REMOTE_URL: origin,
    CLAUDE_REMOTE_SIGNING_KEY: key.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/\n/g, '\\n'),
    CLAUDE_REMOTE_ISSUER: issuer,
    CLAUDE_REMOTE_AUDIENCE: audience,
    ...(mcpOrigin ? { CLAUDE_REMOTE_MCP_ORIGIN: mcpOrigin } : {}),
  }
  const publicEnv = {
    AUTH_PUBLIC_JWK: JSON.stringify(createPublicKey(key).export({ format: 'jwk' })),
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
  }
  const manifest = JSON.parse(await readFile(join(current.service, 'cantelop.json'), 'utf8'))
  manifest.app = app
  const envText = updateEnv(current.source, doop)
  const publicText = updateEnv('', publicEnv)
  // Persist identity first: a failed deployment or interrupted setup must reuse it next time.
  await privateWrite(join(root, '.env'), envText)
  await privateWrite(join(current.service, '.env.setup'), publicText)
  await privateWrite(join(current.service, 'cantelop.local.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await privateWrite(join(root, '.env.claude-hosted'), updateEnv('', doop))
  return { ...current, app, env: { ...current.env, ...doop } }
}

export function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.CLAUDE_REMOTE_SIGNING_KEY
    const child = spawn(command, args, { cwd, stdio: 'inherit', env })
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const cleanup = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
    child.on('error', () => {
      cleanup()
      reject(new Error(`Could not start ${command}. Install it and try again.`))
    })
    child.on('exit', (code) => {
      cleanup()
      if (code === 0) resolve()
      else reject(new Error(`${command} did not complete successfully. Configuration was saved; rerun setup to retry.`))
    })
  })
}

export async function deploySetup(setup, execute = run) {
  await execute('bun', ['install', '--frozen-lockfile'], setup.service)
  // Only the generated public configuration is eligible for upload, never Doop's .env.
  await execute(
    'cantelop',
    ['deploy', '--create-app', '--env-file', '.env.setup', '-config', 'cantelop.local.json'],
    setup.service,
  )
}

export async function verifySetup(env, fetcher = globalThis.fetch) {
  const origin = httpsOrigin(env.CLAUDE_REMOTE_URL)
  const key = createPrivateKey(env.CLAUDE_REMOTE_SIGNING_KEY.replace(/\\n/g, '\n'))
  const sub = 'doop-setup-check'
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({ sub, iss: env.CLAUDE_REMOTE_ISSUER, aud: env.CLAUDE_REMOTE_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60 })}`
  const token = `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  const response = await fetcher(`${origin}/v1/identity`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const error = new Error(
      `Handshake check failed (HTTP ${response.status}). Check the active Cantelop release and rerun with --check.`,
    )
    error.retryable = [404, 502, 503, 504].includes(response.status)
    throw error
  }
  const identity = await response.json()
  const expected = createHash('sha256')
    .update(JSON.stringify([env.CLAUDE_REMOTE_ISSUER, sub]))
    .digest('hex')
    .slice(0, 48)
  if (identity.userId !== expected || identity.workspaceSlug !== `u-${expected}`)
    throw new Error('Handshake returned a different identity. Check the configured issuer and active release.')
}

/** Allow a newly deployed route to become available without redeploying or starting a Session. */
export async function waitForSetup(
  env,
  { verify = verifySetup, pause = delay, attempts = 12, log = console.log } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      await verify(env)
      return
    } catch (error) {
      if (!error.retryable || attempt >= attempts) throw error
      log(`Waiting for the deployed handshake endpoint (${attempt}/${attempts})…`)
      await pause(5000)
    }
  }
}
