import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import puppeteer from 'puppeteer-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'doop-cli-e2e-'))
const install = path.join(work, 'install')
const data = path.join(work, 'user data')
const npm = process.env.npm_execpath
assert.ok(npm, 'Run this test with npm run test:cli')
mkdirSync(install)
const children = new Set()
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(DATABASE_URL|BETTER_AUTH_|TRUSTED_ORIGINS|ADMIN_EMAILS|SMTP_|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY|ENDPOINT|POSTHOG_|VITE_POSTHOG_|ANTHROPIC_|AZURE_|OPENAI_API_KEY|GEMINI_API_KEY|DOOP_|STRIPE_|SIGNUP_EMAIL_DOMAINS|RESIDENT_TASK_LIMIT)/.test(
        key,
      ),
  ),
)

function npmRun(args, cwd) {
  return execFileSync(process.execPath, [npm, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 10 * 1024 * 1024,
  })
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.disconnect()
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
    children.delete(child)
  }
}

let entry
async function start() {
  const child = spawn(process.execPath, [entry, 'start', '--port', '0', '--data-dir', data], {
    cwd: install,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.add(child)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Installed CLI exited ${child.exitCode}: ${output}`)
    const base = output.match(/Doop local: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    if (base && output.includes('doop server')) {
      assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true })
      return { child, base }
    }
    await delay(100)
  }
  throw new Error(`Installed CLI startup timed out: ${output}`)
}

try {
  console.log('Packing and installing the CLI into an isolated npm project…')
  const packedOutput = JSON.parse(
    npmRun(['pack', path.join(root, 'cli-package'), '--json', '--pack-destination', work], root),
  )
  const packed = Object.values(packedOutput)[0]
  assert.ok(packed.files.some((file) => file.path.includes('migrations/meta/_journal.json')))
  assert.ok(packed.files.some((file) => file.path === 'dist/index.html'))
  assert.ok(!packed.files.some((file) => /local-auth|\.env$|data\/pg/.test(file.path)))
  writeFileSync(path.join(install, 'package.json'), '{"private":true}')
  npmRun(['install', '--prefer-offline', '--no-audit', '--no-fund', path.join(work, packed.filename)], install)
  entry = path.join(install, 'node_modules/@killzonegaming/doop-cli/cli/doop.mjs')
  assert.match(npmRun(['exec', '--offline', '--', 'doop', '--help'], install), /Usage: doop start/)
  assert.throws(
    () => execFileSync(process.execPath, [entry, 'start', '--port=-1'], { cwd: install, env, stdio: 'pipe' }),
    /--port must be/,
  )
  console.log('PASS: tarball contents, npm executable and invalid argument handling')
  let running = await start()
  let base = running.base
  const html = await (await fetch(base)).text()
  assert.match(html, /<div id="root">/)
  const asset = html.match(/src="([^"]+\.js)"/)?.[1]
  assert.ok(asset)
  assert.equal((await fetch(new URL(asset, base))).status, 200)
  assert.equal((await fetch(`${base}/api/canvases`)).status, 401)
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 401)
  let cookie = ''
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) cookie = cookies.map((value) => value.split(';')[0]).join('; ')
    assert.ok(response.ok, `${method} ${route}: ${response.status}`)
    return response.json()
  }
  await request('/api/auth/sign-up/email', 'POST', {
    email: 'cli@test.dev',
    password: 'local-test-password-12345',
    name: 'CLI test',
  })
  const canvas = await request('/api/canvases', 'POST', { name: 'CLI persistent canvas' })
  const frame = await request(`/api/canvases/${canvas.id}/frames`, 'POST', { name: 'Persistent frame' })
  await request(`/api/frames/${frame.id}`, 'PATCH', { html: '<h1>CLI persistence works</h1>' })
  const key = await request('/api/agent-keys', 'POST', { name: 'CLI smoke test' })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const upload = await fetch(`${base}/api/canvases/${canvas.id}/assets`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'image/png' },
    body: png,
  })
  assert.equal(upload.status, 200)
  const uploaded = await upload.json()
  async function rpc(method, params) {
    const response = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key.secret}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    assert.equal(response.status, 200)
    return response.text()
  }
  assert.match(
    await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'cli-smoke', version: '1' },
    }),
    /serverInfo/,
  )
  assert.match(await rpc('tools/list', {}), /get_canvas/)
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('WebSocket init timed out'))
    }, 10_000)
    ws.on('error', reject)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'cli-smoke', name: 'CLI', kind: 'user' })),
    )
    ws.on('message', (message) => {
      if (JSON.parse(String(message)).type === 'init') {
        clearTimeout(timer)
        ws.close()
        resolve()
      }
    })
  })
  assert.throws(
    () => execFileSync(process.execPath, [entry, 'start', '--port', '0', '--data-dir', data], { env, stdio: 'pipe' }),
    /Data directory is locked/,
  )
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [entry, 'start', '--port', String(probe.address().port), '--data-dir', path.join(work, 'conflict')],
          { env, stdio: 'pipe' },
        ),
      /Cannot bind local port/,
    )
  } finally {
    await new Promise((resolve) => probe.close(resolve))
  }
  console.log(
    'PASS: static app, signup, canvas/frame editing, WebSockets, MCP authentication/tools, locks and port conflicts',
  )
  const authBefore = readFileSync(path.join(data, 'local-auth.json'))
  await stop(running.child)
  assert.ok(!existsSync(path.join(data, '.doop-lock')), 'Graceful shutdown must release the data lock')
  running = await start()
  base = running.base
  assert.deepEqual(readFileSync(path.join(data, 'local-auth.json')), authBefore)
  const restored = await request(`/api/canvases/${canvas.id}`)
  const assetResponse = await fetch(base + new URL(uploaded.url, base).pathname)
  assert.equal(assetResponse.status, 200)
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, 'Uploaded asset must survive restart')
  assert.equal(restored.name, 'CLI persistent canvas')
  assert.equal(restored.frames.find((value) => value.id === frame.id).html, '<h1>CLI persistence works</h1>')
  assert.match(
    await rpc('tools/call', { name: 'get_canvas', arguments: { canvas_id: canvas.id } }),
    /CLI persistent canvas/,
  )
  const chrome = [
    process.env.CHROME_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => candidate && existsSync(candidate))
  if (chrome) {
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] })
    try {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await browser.setCookie(
        ...cookie.split('; ').map((pair) => {
          const separator = pair.indexOf('=')
          return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: base }
        }),
      )
      await page.goto(`${base}/c/${canvas.id}`, { waitUntil: 'networkidle0', timeout: 30_000 })
      await page.waitForFunction('document.body.textContent.includes("CLI persistent canvas")', { timeout: 15_000 })
      assert.deepEqual(errors, [], 'The production browser app should load without uncaught errors')
      console.log('PASS: real Chrome loads the authenticated production canvas after restart')
    } finally {
      await browser.close()
    }
  } else {
    assert.ok(!process.env.CI, 'CI must provide Chrome for the browser E2E check')
    console.log('SKIP: browser rendering (no Chrome installed; set CHROME_PATH)')
  }
  console.log('PASS: graceful shutdown, restart, session/key stability, persisted canvas/frame and MCP canvas read')
  await stop(running.child)
  console.log('All installed-package CLI E2E checks passed.')
} finally {
  for (const child of children) await stop(child)
  rmSync(work, { recursive: true, force: true })
}
