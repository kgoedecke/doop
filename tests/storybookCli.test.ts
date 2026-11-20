import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server as HttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import type { Canvas } from '../shared/types'
import type { StorybookSourceView } from '../shared/storybookSource'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/*
 * The CLI as a developer runs it: built to public/cli, a Storybook on localhost that the server
 * cannot reach (tests/fixtures/iframe.html behind a local index.json), Chrome through
 * puppeteer-core, the captures sent to a real server with an agent key.
 */

describe.skipIf(!findBrowserPath())('the Storybook CLI', () => {
  const run = promisify(execFile)
  let server: Server
  let storybook: HttpServer
  let storybookUrl = ''
  let owner: Client

  beforeAll(async () => {
    await run('node', ['scripts/build-storybook-cli.mjs'])
    const preview = readFileSync('tests/fixtures/iframe.html')
    const index = JSON.stringify({
      v: 5,
      entries: {
        'ui-button--default': {
          type: 'story',
          id: 'ui-button--default',
          title: 'UI/Button',
          name: 'Default',
          componentPath: './src/ui/Button.tsx',
        },
      },
    })
    storybook = createServer((req, res) => {
      if (req.url?.startsWith('/index.json')) res.writeHead(200, { 'content-type': 'application/json' }).end(index)
      else if (req.url?.startsWith('/iframe.html')) res.writeHead(200, { 'content-type': 'text/html' }).end(preview)
      else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => storybook.listen(0, '127.0.0.1', resolve))
    storybookUrl = `http://127.0.0.1:${(storybook.address() as AddressInfo).port}/`
    server = await startServer(process.env.FID_DUMP ? { FID_DUMP: process.env.FID_DUMP } : {})
    owner = await new Client(server).signUp('storybook-cli@test.dev', 'CLI Owner')
  }, 90_000)

  afterAll(async () => {
    storybook?.close()
    await server?.stop()
  })

  it('lists a local Storybook and pushes it onto a canvas', async () => {
    const env = { ...process.env, CHROME_PATH: process.env.CHROME_PATH ?? findBrowserPath() ?? '' }
    const listed = await run('node', ['public/cli/doop-storybook.mjs', 'list', storybookUrl], { env })
    expect(listed.stdout).toContain('UI/Button\t1 stories\tsrc/ui/Button.tsx')

    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'From the CLI' })).json()
    const { secret } = (await (await owner.post('/api/agent-keys', { name: 'CLI' })).json()) as { secret: string }
    const pushed = await run(
      'node',
      ['public/cli/doop-storybook.mjs', 'push', storybookUrl, '--canvas', canvas.id, '--server', server.base],
      { env: { ...env, DOOP_KEY: secret }, timeout: 120_000 },
    )
    expect(pushed.stdout).toContain('rendered Button')
    expect(pushed.stdout).toMatch(/created\s+Button · \d+% match/)

    const { sources } = (await (await owner.get(`/api/canvases/${canvas.id}/storybook/sources`)).json()) as {
      sources: StorybookSourceView[]
    }
    expect(sources[0]).toMatchObject({ url: storybookUrl, components: [{ title: 'UI/Button' }] })
    const result = sources[0]!.lastResult!.components[0]!
    expect(result.outcome).toBe('created')
    /* captured on this machine and drawn by Doop's renderer: the same button */
    expect(result.fidelity).toBeGreaterThan(0.9)
  }, 180_000)
})
