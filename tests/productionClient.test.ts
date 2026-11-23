import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { freePort, startServer, type Server } from './harness'

function writeBuild(dir: string, bundle: string) {
  mkdirSync(path.join(dir, 'assets'), { recursive: true })
  writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><html data-doop-default-locale=""><script type="module" src="/assets/${bundle}"></script></html>`,
  )
  writeFileSync(path.join(dir, 'assets', bundle), 'export {}')
}

it('serves the new entry point and its locale when a build is replaced without a restart', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'doop-production-client-'))
  const dist = path.join(dataDir, 'dist')
  const nextDist = path.join(dataDir, 'next-dist')
  let server: Server | undefined
  try {
    writeBuild(dist, 'before.js')
    writeBuild(nextDist, 'after.js')
    server = await startServer(
      {
        PORT: String(await freePort()),
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234',
        DEFAULT_LOCALE: 'pt-BR',
      },
      dataDir,
    )
    const before = await fetch(`${server.base}/auth`)
    expect(await before.text()).toContain('/assets/before.js')

    renameSync(dist, path.join(dataDir, 'previous-dist'))
    renameSync(nextDist, dist)

    for (const route of ['/auth', '/index.html']) {
      const response = await fetch(server.base + route)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('/assets/after.js')
      expect(html).toContain('data-doop-default-locale="pt-BR"')
    }
    expect((await fetch(`${server.base}/assets/after.js`)).status).toBe(200)
    expect((await fetch(`${server.base}/assets/before.js`)).status).toBe(404)
  } finally {
    server?.stop({ keepData: true })
    await server?.stopped
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 30_000)
