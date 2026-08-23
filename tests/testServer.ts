import { once } from 'node:events'
import { createServer } from 'node:net'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

export type TestChild = ChildProcessByStdio<null, Readable, Readable>

export async function availablePort(): Promise<number> {
  const probe = createServer()
  probe.unref()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') {
    probe.close()
    throw new Error('failed to allocate a test port')
  }
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())))
  return port
}

export function captureOutput(child: TestChild): () => string {
  let output = ''
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  return () => output.trim()
}

export async function waitForHealth(
  child: TestChild,
  url: string,
  output: () => string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = output()
      throw new Error(
        `server exited before becoming healthy (code=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'})${detail ? `\n${detail}` : ''}`,
      )
    }
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      const detail = output()
      throw new Error(`server did not boot within ${timeoutMs}ms${detail ? `\n${detail}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function stopChild(child: TestChild | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}
