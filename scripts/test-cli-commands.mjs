import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'

/** Exercise command groups against a real installed package and detached service. */
export async function exerciseCommands(entry, install, work, env, archive) {
  const directory = path.join(work, 'managed service')
  const destination = path.join(work, 'agent config')
  const run = (args, input) =>
    execFileSync(process.execPath, [entry, ...args, '--data-dir', directory], {
      cwd: install,
      env,
      encoding: 'utf8',
      input,
      // Upgrades perform a real npm install; cold Windows CI installs need the
      // same allowance as the initial tarball installation in test-cli.mjs.
      timeout: ['upgrade', 'update'].includes(args[0]) ? (env.CI ? 600_000 : 240_000) : 120_000,
      maxBuffer: 1024 * 1024,
    })
  const json = (args) => JSON.parse(run(args))
  const version = run(['--version']).trim()
  assert.match(version, /-cli\.1$/)
  assert.equal(json(['service']).running, false)
  assert.equal(json(['service', 'install', '--port', '0']).autostart, false)
  let running
  try {
    running = json(['service', 'start'])
    assert.equal(running.running, true)
    assert.equal(json(['service', 'start']).pid, running.pid, 'Repeated start must reuse the service')
    const state = JSON.parse(readFileSync(path.join(directory, 'service-state.json'), 'utf8'))
    for (const message of ['{"token":"wrong","command":"stop"}\n', '{malformed\n'])
      await new Promise((resolve, reject) => {
        const socket = createConnection(state.socket)
        let text = ''
        socket.on('error', reject)
        socket.on('connect', () => socket.write(message))
        socket.on('data', (chunk) => {
          text += chunk
        })
        socket.on('close', () => {
          assert.equal(text, '{}')
          resolve()
        })
      })
    assert.equal(json(['service', 'status']).running, true)
    assert.deepEqual(json(['api', '/healthz']), { ok: true })
    assert.throws(() => run(['api', '/api/canvases']), /HTTP 401/)
    assert.throws(() => run(['api', '//example.com']), /must stay on/)
    const password = 'cli-command-fixture-password-12345'
    const signup = await fetch(`${running.url}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: running.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'commands@test.dev', password, name: 'Commands' }),
    })
    assert.equal(signup.status, 200)
    const loggedIn = run(['auth', 'login', '--email', 'commands@test.dev', '--password-stdin'], password + '\n')
    assert.equal(JSON.parse(loggedIn).authenticated, true)
    assert.ok(!loggedIn.includes(password))
    assert.equal(json(['auth', 'status']).email, 'commands@test.dev')
    const payload = path.join(work, 'canvas.json')
    writeFileSync(payload, JSON.stringify({ name: 'Managed CLI canvas' }))
    const canvas = json(['api', 'POST', '/api/canvases', '--data', '@' + payload])
    assert.equal(json(['api', `/api/canvases/${canvas.id}`]).name, 'Managed CLI canvas')
    const reload = json(['reload'])
    assert.equal(reload.reloaded, true)
    assert.equal(reload.url, running.url)
    assert.equal(json(['api', `/api/canvases/${canvas.id}`]).name, 'Managed CLI canvas')
    assert.equal(json(['doctor', '--json']).ok, true)
    const debug = run(['debug', 'config'])
    const auth = JSON.parse(readFileSync(path.join(directory, 'local-auth.json'), 'utf8'))
    assert.ok(!debug.includes(auth.secret) && !debug.includes(state.token))
    assert.equal(json(['pair']).url, running.url + '/mcp')
    for (const client of ['codex', 'claude', 'cursor', 'opencode']) {
      const paired = json(['pair', '--client', client, '--directory', destination])
      assert.equal(paired.paired, true)
      assert.ok(readFileSync(paired.file, 'utf8').includes(running.url))
      const installed = json(['skill', 'install', '--client', client, '--directory', destination])
      assert.match(readFileSync(installed.file, 'utf8'), /name: doop/)
    }
    assert.throws(() => run(['pair', '--client', 'cursor', '--directory', destination]), /already exists/)
    assert.throws(() => run(['skill', 'install', '--directory', destination]), /already exists/)
    assert.match(run(['skill', 'show']), /get_guide/)
    assert.equal(json(['auth', 'logout']).authenticated, false)
    assert.throws(() => run(['auth', 'status']), /HTTP 401/)
    assert.equal(json(['service', 'stop']).running, false)
    const restarted = json(['service', 'start'])
    assert.equal(restarted.running, true)
    assert.equal(
      JSON.parse(run(['auth', 'login', '--email', 'commands@test.dev', '--password-stdin'], password)).authenticated,
      true,
    )
    assert.equal(json(['api', `/api/canvases/${canvas.id}`]).name, 'Managed CLI canvas')
    assert.equal(json(['service', 'uninstall']).dataRetained, true)
    assert.ok(existsSync(path.join(directory, 'data/pg')))
    const plan = json(['upgrade', archive, '--dry-run'])
    assert.deepEqual(json(['update', archive, '--dry-run']), plan)
    const prefix = path.join(work, 'upgraded installation')
    const upgraded = run(['upgrade', archive, '--prefix', prefix])
    assert.match(upgraded, /"upgraded": true/)
    const installedEntry = path.join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      '@killzonegaming/doop-cli/cli/doop.mjs',
    )
    assert.ok(existsSync(installedEntry))
    assert.equal(
      execFileSync(process.execPath, [installedEntry, '--version'], { encoding: 'utf8', env }).trim(),
      version,
    )
    console.log(
      'PASS: detached service, control authentication, reload, API/session commands, MCP pairing configs, skill installation, diagnostics and actual tarball upgrade',
    )
  } finally {
    run(['service', 'stop'])
  }
}
