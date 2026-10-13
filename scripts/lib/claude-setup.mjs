import { createHash, randomUUID } from 'node:crypto'
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
  // Migrate saved Doop aliases; the runtime uses the SDK's native variables directly.
  if (!env.CANTELOP_APP_SLUG && env.CLAUDE_REMOTE_APP) env.CANTELOP_APP_SLUG = env.CLAUDE_REMOTE_APP
  if (!env.CANTELOP_EDGE_URL && env.CLAUDE_REMOTE_URL) env.CANTELOP_EDGE_URL = env.CLAUDE_REMOTE_URL
  const app =
    env.CANTELOP_APP_SLUG ||
    (local && JSON.parse(local).app) ||
    /^https:\/\/([a-z0-9-]+)\.cantelop\.dev\/?$/.exec(env.CANTELOP_EDGE_URL ?? '')?.[1]
  return { root, service, source, env, app }
}

export async function prepareSetup(root, { app, mcpOrigin }) {
  if (!/^(?!.*--)[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(app ?? ''))
    throw new Error(
      'App name must be 3–63 lowercase letters, digits, or hyphens, starting with a letter and ending with a letter or digit.',
    )
  const current = await readSetup(root)
  if (current.app && current.app !== app)
    throw new Error(
      `This checkout is already paired with ${current.app}. Use a separate checkout for another deployment.`,
    )
  const origin = `https://${app}.cantelop.dev`
  if (current.env.CANTELOP_EDGE_URL && httpsOrigin(current.env.CANTELOP_EDGE_URL) !== origin)
    throw new Error(
      'The existing CANTELOP_EDGE_URL belongs to another deployment. Keep its configuration or use a separate checkout.',
    )
  mcpOrigin ??= current.env.CLAUDE_REMOTE_MCP_ORIGIN
  if (mcpOrigin) mcpOrigin = httpsOrigin(mcpOrigin)
  // This issuer is a durable namespace, not a JWT issuer in SDK 1.0.
  // Preserve it when migrating so existing users keep the same Workspace.
  const issuer = current.env.CLAUDE_REMOTE_ISSUER || `urn:doop:${randomUUID()}`
  const doop = {
    CANTELOP_EDGE_URL: origin,
    CANTELOP_APP_SLUG: app,
    CLAUDE_REMOTE_ISSUER: issuer,
    ...(current.env.CANTELOP_INTEGRATION_TOKEN
      ? { CANTELOP_INTEGRATION_TOKEN: current.env.CANTELOP_INTEGRATION_TOKEN }
      : {}),
    ...(mcpOrigin ? { CLAUDE_REMOTE_MCP_ORIGIN: mcpOrigin } : {}),
  }
  const manifest = JSON.parse(await readFile(join(current.service, 'cantelop.json'), 'utf8'))
  manifest.definition = 'src/cantelop.local.ts'
  const definition = await readFile(join(current.service, 'src/cantelop.ts'), 'utf8')
  const localDefinition = definition.replace("name: 'doop-claude-runtime'", `name: '${app}'`)
  const envText = updateEnv(current.source, doop)
  const publicText = '# SDK 1.0 uses native Workspace auth. No application keys belong in the Sandbox.\n'
  // Persist identity first: a failed deployment or interrupted setup must reuse it next time.
  await privateWrite(join(root, '.env'), envText)
  await privateWrite(join(current.service, '.env.setup'), publicText)
  await privateWrite(join(current.service, 'src/cantelop.local.ts'), localDefinition)
  await privateWrite(join(current.service, 'cantelop.local.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await privateWrite(join(root, '.env.claude-hosted'), updateEnv('', doop))
  return { ...current, app, env: { ...current.env, ...doop } }
}

export function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.CLAUDE_REMOTE_SIGNING_KEY
    delete env.CANTELOP_INTEGRATION_TOKEN
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
  if (!setup.env.CANTELOP_INTEGRATION_TOKEN)
    throw new Error(
      'SDK 1.0 requires an App-scoped CANTELOP_INTEGRATION_TOKEN in Doop’s .env. Obtain it from the compatible Cantelop platform; never use a CLI login token.',
    )
  await execute('bun', ['install', '--frozen-lockfile'], setup.service)
  // Requires the coordinated schema-3/build-protocol-6 CLI/platform release.
  // No backend token or signing key is uploaded as Sandbox environment.
  await execute('cantelop', ['deploy', '--create-app', '-config', 'cantelop.local.json'], setup.service)
  await execute('node', ['scripts/build-claude-client.mjs'], setup.root)
}

/** Authenticated read of a missing projection; never provisions a Workspace/Sandbox. */
export async function verifySetup(env, fetcher = globalThis.fetch, runtimeId) {
  const origin = httpsOrigin(env.CANTELOP_EDGE_URL)
  if (!env.CANTELOP_INTEGRATION_TOKEN || !runtimeId)
    throw new Error('Set CANTELOP_INTEGRATION_TOKEN and build the SDK backend client before checking the connection.')
  const userId = createHash('sha256')
    .update(JSON.stringify([env.CLAUDE_REMOTE_ISSUER, 'doop-setup-check']))
    .digest('hex')
    .slice(0, 48)
  const id = `msg_${randomUUID().replaceAll('-', '')}`
  const response = await fetcher(`${origin}/commands`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CANTELOP_INTEGRATION_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Cantelop-Session-Runtime': runtimeId,
    },
    body: JSON.stringify({
      protocolVersion: 2,
      id,
      workspace: { slug: `u-${userId}` },
      session: { id: `${userId}:setup-probe` },
      command: { type: 'view' },
    }),
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(15_000),
  })
  const result = await response.json().catch(() => ({}))
  if (response.status === 404 && ['resource_not_found', 'session_view_not_found'].includes(result.error?.code)) return
  const error = new Error(
    `SDK connection check failed (HTTP ${response.status}). Check the integration token, runtime identity and compatible Cantelop release.`,
  )
  error.retryable = [502, 503, 504].includes(response.status)
  throw error
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
      log(`Waiting for the deployed SDK endpoint (${attempt}/${attempts})…`)
      await pause(5000)
    }
  }
}
