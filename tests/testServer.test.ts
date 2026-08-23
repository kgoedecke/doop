import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { availablePort, captureOutput, stopChild, waitForHealth } from './testServer'

describe('test server helpers', () => {
  it('returns a port that can be bound', async () => {
    const port = await availablePort()
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it('reports child stderr when the server exits before becoming healthy', async () => {
    const child = spawn(process.execPath, ['-e', "console.error('startup boom'); process.exit(23)"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = captureOutput(child)

    await expect(waitForHealth(child, 'http://127.0.0.1:1/healthz', output, 5_000)).rejects.toThrow(
      /code=23[\s\S]*startup boom/,
    )
    await stopChild(child)
  })
})
