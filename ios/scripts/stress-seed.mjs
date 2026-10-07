// Seed a local doop server with a test account and a canvas of many real
// frames for the iOS stress test. Local development only: the account is a
// throwaway on the dev server's embedded database.
//   node ios/scripts/stress-seed.mjs <frames-dir-with-manifest.json> [count] [server]
// manifest.json: [{ "file": "x.html", "width": 1280, "height": 800 }, ...]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , dir, countArg, serverArg] = process.argv
if (!dir) {
  console.error('usage: node ios/scripts/stress-seed.mjs <frames-dir> [count] [server]')
  process.exit(2)
}
const count = Number(countArg || 60)
const server = serverArg || 'http://localhost:4400'
// Test-only credentials for the local dev server; the iOS app reads the same
// values from its -testEmail / -testPassword launch arguments.
export const TEST_ACCOUNT = { email: 'stress@doop.test', password: 'stress-test-pass-2026', name: 'Stress Tester' }

let cookie = ''
async function call(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(server + path, {
    method,
    headers: { 'content-type': 'application/json', cookie, origin: server },
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const signUp = await fetch(server + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: server },
  body: JSON.stringify(TEST_ACCOUNT),
})
if (!signUp.ok && signUp.status !== 422) console.log('sign-up:', signUp.status, (await signUp.text()).slice(0, 120))
await call('/api/auth/sign-in/email', { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password })

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
const canvas = await call('/api/canvases', { name: `Stress ${count} frames` })
const columns = Math.ceil(Math.sqrt(count * 1.6))
let x = 0,
  y = 0,
  rowHeight = 0,
  created = 0
for (let i = 0; i < count; i++) {
  const spec = manifest[i % manifest.length]
  if (i % columns === 0 && i > 0) {
    x = 0
    y += rowHeight + 160
    rowHeight = 0
  }
  await call(`/api/canvases/${canvas.id}/frames`, {
    name: `${spec.file.replace('.html', '')} ${i + 1}`,
    x,
    y,
    width: spec.width,
    height: spec.height,
    html: readFileSync(join(dir, spec.file), 'utf8'),
  })
  x += spec.width + 120
  rowHeight = Math.max(rowHeight, spec.height)
  created++
}
console.log(JSON.stringify({ canvasId: canvas.id, frames: created, columns }))
