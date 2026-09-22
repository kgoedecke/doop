import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nativeLogin } from '../src/login-process.js'
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
async function fixture(t: any, script: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cantelop-login-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const binary = join(dir, 'fake-claude')
  await writeFile(binary, '#!/usr/bin/env python3\n' + script, { mode: 0o755 })
  return nativeLogin(dir, resolve('runtime/login-pty.py'), binary)
}
test('PTY supports native code entry with echo disabled and delivers final output', async (t) => {
  const launch = await fixture(
    t,
    "import sys, os\nassert sys.stdin.isatty()\nprint('Enter code:',flush=True)\ncode=input()\nassert code=='private-code'\nprint('Login successful',flush=True)\n",
  )
  let output = ''
  const controller = new AbortController()
  let ready!: () => void
  const prompt = new Promise<void>((r) => {
    ready = r
  })
  const process = launch(controller.signal, async (text) => {
    output += text
    if (output.includes('Enter code:')) ready()
  })
  await prompt
  await process.write('private-code\r')
  assert.equal(await process.done, 0)
  assert.match(output, /Login successful/)
  assert.ok(!output.includes('private-code'))
})
test('PTY cancellation reaps a child ignoring SIGTERM', async (t) => {
  const launch = await fixture(
    t,
    "import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('ready',flush=True)\ntime.sleep(30)\n",
  )
  const controller = new AbortController()
  let ready!: () => void
  const prompt = new Promise<void>((r) => {
    ready = r
  })
  const process = launch(controller.signal, async (text) => {
    if (text.includes('ready')) ready()
  })
  await prompt
  const start = Date.now()
  controller.abort()
  assert.notEqual(await process.done, 0)
  assert.ok(Date.now() - start >= 900)
})
