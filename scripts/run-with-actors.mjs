import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startLocalActors } from 'durable-actors/dev'

const root = fileURLToPath(new URL('../', import.meta.url))
const entrypoint = 'src/actor.ts'

export function testEnvironment(environment) {
  const env = { ...environment }
  const settings = new Set([
    'DATABASE_URL',
    'NODE_ENV',
    'PORT',
    'VITE_PORT',
    'TRUSTED_ORIGINS',
    'ADMIN_EMAILS',
    'SIGNUP_EMAIL_DOMAINS',
    'REQUIRE_EMAIL_VERIFICATION',
    'BUCKET',
    'ACCESS_KEY_ID',
    'SECRET_ACCESS_KEY',
    'ENDPOINT',
    'REGION',
    'EMAIL_FROM',
  ])
  for (const key of Object.keys(env)) {
    if (
      settings.has(key) ||
      /^(BETTER_AUTH|ANTHROPIC|OPENAI|AZURE|SMTP|STRIPE|OIDC|GOOGLE|MICROSOFT|CONTEXT_DEV|DOOP_AGENT)_/.test(key)
    )
      delete env[key]
  }
  return env
}

export function actorEnvironment(environment, connection) {
  const env = { ...environment }
  // SDK aliases and inherited credentials must never override a managed runtime.
  for (const key of Object.keys(env)) {
    if (
      /^DURABLE_(ACTORS|OBJECT)_/.test(key) ||
      /^TERSE_(ACTOR_URL|API_KEY)$/.test(key) ||
      /^DOOP_ACTORS_(INTERNAL_KEY|URL|API_KEY)$/.test(key) ||
      key === 'DOOP_LOCAL_ACTOR_URL'
    )
      delete env[key]
  }
  return {
    ...env,
    DURABLE_ACTORS_CONTROL_PLANE_URL: connection.controlPlaneUrl,
    DURABLE_ACTORS_PROJECT_ID: connection.projectId,
    ...(connection.apiKey ? { DURABLE_ACTORS_SECRET: connection.apiKey } : {}),
  }
}

async function startManagedActors(options) {
  // The SDK spawns using process.env, not an options.env. Keep runtime download
  // overrides, but never inherit hosted storage/provider/credential settings.
  const inherited = {}
  for (const key of Object.keys(process.env)) {
    if (
      (/^DURABLE_(ACTORS|OBJECT)_/.test(key) && !['DURABLE_ACTORS_BINARY', 'DURABLE_ACTORS_CACHE_DIR'].includes(key)) ||
      /^TERSE_(ACTOR_URL|API_KEY)$/.test(key) ||
      /^DOOP_ACTORS_(INTERNAL_KEY|URL|API_KEY)$/.test(key) ||
      key === 'DOOP_LOCAL_ACTOR_URL'
    ) {
      inherited[key] = process.env[key]
      delete process.env[key]
    }
  }
  try {
    return await startLocalActors(options)
  } finally {
    Object.assign(process.env, inherited)
  }
}

export async function prepareActors({ test = false, environment = process.env } = {}) {
  if (test) environment = testEnvironment(environment)
  // Tests are isolated even if the developer's shell points at production.
  // External testing is opt-in and must target a disposable QA project.
  if (test && environment.DOOP_TEST_ACTORS && !['local', 'external'].includes(environment.DOOP_TEST_ACTORS))
    throw new Error('DOOP_TEST_ACTORS must be local or external.')
  const external = test
    ? environment.DOOP_TEST_ACTORS === 'external'
    : !!(environment.TERSE_ACTOR_URL || environment.DURABLE_ACTORS_CONTROL_PLANE_URL)
  if (external) {
    if (!environment.TERSE_ACTOR_URL && !environment.DURABLE_ACTORS_CONTROL_PLANE_URL)
      throw new Error('External actor mode requires DURABLE_ACTORS_CONTROL_PLANE_URL or TERSE_ACTOR_URL.')
    return { env: { ...environment }, owned: false, stop: async () => {} }
  }
  const temporary = test ? await mkdtemp(path.join(tmpdir(), 'doop-actors-')) : undefined
  const port = test ? 0 : Number(environment.DOOP_ACTORS_PORT || 7100)
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('DOOP_ACTORS_PORT must be an integer from 0 to 65535.')
  try {
    const runtime = await startManagedActors({
      project: root,
      entrypoint,
      projectId: 'local',
      apiKey: randomUUID(),
      port,
      dataDir: temporary || environment.DOOP_ACTORS_DATA_DIR || 'data/actors',
      startupTimeoutMs: 120_000,
    })
    console.log(`[actors] ${test ? 'Isolated test' : 'Local'} runtime ready at ${runtime.connection.controlPlaneUrl}`)
    let stopped
    return {
      env: actorEnvironment(environment, runtime.connection),
      owned: true,
      closed: runtime.closed,
      stop: () =>
        (stopped ??= (async () => {
          await runtime.stop()
          if (temporary) await rm(temporary, { recursive: true, force: true })
        })()),
    }
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2)
  if (!['dev', 'test', 'start'].includes(mode)) throw new Error('Expected dev, test, or start.')
  const test = mode === 'test'
  // Do not import a developer's .env into CI/tests. Shell values still win in dev.
  if (!test) {
    try {
      process.loadEnvFile(path.join(root, '.env'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const children = new Set()
  let actors
  let stopping = false

  function signalChild(child, signal) {
    if (!child.pid) return
    try {
      child.kill(signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }

  function childExited(child) {
    return new Promise((resolve) => {
      child.once('exit', resolve)
      if (child.exitCode !== null || child.signalCode !== null) resolve()
    })
  }

  async function stopChild(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = childExited(child)
    signalChild(child, 'SIGTERM')
    const timer = setTimeout(() => signalChild(child, 'SIGKILL'), 3_000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }

  function forceExit(code) {
    for (const child of children) signalChild(child, 'SIGKILL')
    process.exit(code)
  }

  async function stop(code) {
    if (stopping) return
    stopping = true
    const forced = setTimeout(() => forceExit(code), 8_000)
    forced.unref()
    process.exitCode = code
    await Promise.all([...children].map(stopChild))
    // The runtime is in this process group, so Ctrl+C may already have stopped it.
    await actors?.stop().catch(() => {})
    clearTimeout(forced)
    process.exit(code)
  }
  let signals = 0
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])
    process.on(signal, () => {
      signals += 1
      if (signals > 1) forceExit(code)
      void stop(code).catch((error) => {
        console.error(error)
        forceExit(1)
      })
    })

  function launch(command) {
    // Stay in the terminal's process group. A detached child calls setsid(), so
    // Ctrl+C never reaches it, and killing the launcher leaves the dev servers running.
    const child = spawn(process.execPath, command, { cwd: root, env: actors.env, stdio: 'inherit' })
    children.add(child)
    child.once('error', (error) => {
      children.delete(child)
      console.error(error)
      void stop(1)
    })
    child.once('exit', (code, signal) => {
      children.delete(child)
      if (!stopping) void stop(signal ? 1 : (code ?? 1))
    })
  }

  try {
    actors = await prepareActors({ test })
    if (mode === 'start' && actors.owned) actors.env.DOOP_LOCAL_ACTOR_URL = actors.env.DURABLE_ACTORS_CONTROL_PLANE_URL
    if (stopping) {
      await actors.stop()
    } else {
      actors.closed?.then(
        () => {
          if (!stopping) {
            console.error('[actors] Runtime stopped unexpectedly.')
            void stop(1)
          }
        },
        (error) => {
          if (stopping) return
          console.error(error)
          void stop(1)
        },
      )
      if (mode === 'dev') {
        launch(['node_modules/tsx/dist/cli.mjs', 'watch', 'server/index.ts'])
        launch(['node_modules/vite/bin/vite.js', '--strictPort', ...args])
      } else if (mode === 'start') launch(['--import', 'tsx', 'server/index.ts'])
      else launch(['node_modules/vitest/vitest.mjs', 'run', ...args])
    }
  } catch (error) {
    console.error(error)
    await stop(1)
  }
  // Let child exit handlers finish before Node decides there is no more work.
  while (children.size) await delay(100)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
