import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import JSZip from 'jszip'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

let server: Server
let directory: string
let archive: JSZip

beforeAll(async () => {
  // The Docker build stage runs scripts under Bun; Claude runs the extracted
  // proxy under Node. Exercise that runtime boundary rather than Node-only.
  execFileSync('bun', ['scripts/build-claude-extension.mjs'])
  archive = await JSZip.loadAsync(await readFile('public/claude-extension/doop.mcpb'))
  directory = await mkdtemp(join(tmpdir(), 'doop-claude-extension-'))
  for (const file of Object.values(archive.files)) {
    if (file.dir) continue
    const destination = join(directory, file.name)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, await file.async('nodebuffer'))
    if (typeof file.unixPermissions === 'number') await chmod(destination, file.unixPermissions & 0o777)
  }
  server = await startServer()
}, 70_000)

afterAll(async () => {
  server?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('packages the same installed dependencies under Bun and Node', async () => {
  execFileSync(process.execPath, ['scripts/build-claude-extension.mjs'])
  const nodeArchive = await JSZip.loadAsync(await readFile('public/claude-extension/doop.mcpb'))
  expect(Object.keys(archive.files).sort()).toEqual(Object.keys(nodeArchive.files).sort())
  for (const name of Object.keys(archive.files).filter((name) => name.endsWith('/package.json'))) {
    expect(await archive.file(name)!.async('string'), name).toBe(await nodeArchive.file(name)!.async('string'))
  }
  // mcp-remote needs undici 7; Doop itself uses 8. Keep the nested dependency.
  const undici = JSON.parse(
    await archive.file('node_modules/mcp-remote/node_modules/undici/package.json')!.async('string'),
  )
  expect(undici.version).toMatch(/^7\./)
})

it('ships an installable manifest and all runtime files without repository credentials', async () => {
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'))
  expect(archive.file(manifest.server.entry_point)).not.toBeNull()
  expect(archive.file(manifest.icon)).not.toBeNull()
  expect(archive.file('LICENSE')).not.toBeNull()
  expect(manifest.server.mcp_config.command).toBe('node')
  expect(manifest.user_config.server_url.default).toBe('https://doop.design/mcp')
  expect(Object.keys(archive.files).some((name) => /(^|\/)\.env($|\.)|\.mcp-auth/.test(name))).toBe(false)
  // open uses a sibling script on Linux; bundling JS alone silently loses it.
  expect(archive.file('node_modules/open/xdg-open')).not.toBeNull()
})

it('runs the extracted download and forwards real Doop tools, instructions and resources', async () => {
  const owner = await new Client(server).signUp('extension@test.dev', 'Extension Owner')
  const { secret } = (await (await owner.post('/api/agent-keys', { name: 'extension-test' })).json()) as {
    secret: string
  }
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'))
  const args = (manifest.server.mcp_config.args as string[]).map((arg) =>
    arg.replace('${__dirname}', directory).replace('${user_config.server_url}', `${server.base}/mcp`),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...args, '--header', 'Authorization:Bearer ${DOOP_EXTENSION_TEST_KEY}'],
    cwd: directory,
    env: { DOOP_EXTENSION_TEST_KEY: secret, MCP_REMOTE_CONFIG_DIR: join(directory, 'auth') },
    stderr: 'pipe',
  })
  const client = new McpClient({ name: 'Claude extension test', version: '1.0.0' })
  let errors = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  try {
    await client.connect(transport)
    expect(client.getInstructions()).toContain('get_guide')
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('create_frame')
    const result = await client.callTool({ name: 'get_guide', arguments: { topic: 'doop-instructions' } })
    expect(result.isError, errors).not.toBe(true)
    expect(result.content).not.toEqual([])
    const { resources } = await client.listResources()
    const preview = resources.find((resource) => resource.uri.startsWith('ui://doop/'))
    expect(preview).toBeDefined()
    expect((await client.readResource({ uri: preview!.uri })).contents).not.toEqual([])
  } finally {
    await client.close()
  }
}, 30_000)

it('completes OAuth with Doop and reuses the sign-in after restarting the extension', async () => {
  const owner = await new Client(server).signUp('extension-oauth@test.dev', 'OAuth Owner')
  const stranger = await new Client(server).signUp('extension-stranger@test.dev', 'Stranger')
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'))
  const args = (manifest.server.mcp_config.args as string[]).map((arg) =>
    arg.replace('${__dirname}', directory).replace('${user_config.server_url}', `${server.base}/mcp`),
  )
  // Replace only the browser launcher in the temporary extraction. The real
  // proxy still performs discovery, registration, PKCE, exchange and caching.
  const opener = join(directory, 'node_modules/open/index.js')
  const original = await readFile(opener)
  await writeFile(
    opener,
    `
    import { spawn } from 'node:child_process'
    export default async function(url) {
      process.stderr.write('DOOP_TEST_AUTHORIZE ' + url + '\\n')
      return spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    }
  `,
  )
  let launches = 0
  const authorize = async (url: URL) => {
    launches++
    expect(url.origin).toBe(server.base)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const response = await owner.get(url.pathname + url.search)
    const approval = new URL(response.headers.get('location')!, server.base)
    expect(approval.pathname).toBe('/oauth/consent')
    const endpoint = `/api/mcp-consent/${approval.searchParams.get('consent_code')}`
    expect(await (await owner.get(endpoint)).json()).toEqual({ name: 'Doop for Claude Desktop' })
    expect((await stranger.get(endpoint)).status).toBe(404)
    expect((await stranger.post(endpoint, { accept: true })).status).toBe(404)
    const accepted = await owner.post(endpoint, { accept: true })
    expect(accepted.status).toBe(200)
    const { redirectURI } = (await accepted.json()) as { redirectURI: string }
    const callback = new URL(redirectURI)
    expect(callback.searchParams.has('code')).toBe(true)
    expect((await fetch(callback)).ok).toBe(true)
    expect((await owner.post(endpoint, { accept: true })).status).toBe(404)

    // A separate request can be denied without granting a reusable code.
    const next = await owner.get(url.pathname + url.search)
    const deniedCode = new URL(next.headers.get('location')!, server.base).searchParams.get('consent_code')
    const denied = await owner.post(`/api/mcp-consent/${deniedCode}`, { accept: false })
    expect(new URL(((await denied.json()) as { redirectURI: string }).redirectURI).searchParams.get('error')).toBe(
      'access_denied',
    )
    expect((await owner.get(`/api/mcp-consent/${deniedCode}`)).status).toBe(404)
  }
  try {
    for (let run = 0; run < 2; run++) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        cwd: directory,
        env: { MCP_REMOTE_CONFIG_DIR: join(directory, 'oauth') },
        stderr: 'pipe',
      })
      const client = new McpClient({ name: 'Claude OAuth test', version: '1.0.0' })
      const lines = createInterface({ input: transport.stderr as Readable })
      let browserError: unknown
      let diagnostics = ''
      let authorizationUrl: URL | undefined
      let callbackReady = false
      let authorization: Promise<void> | undefined
      lines.on('line', (line) => {
        diagnostics += `${line}\n`
        if (line.startsWith('DOOP_TEST_AUTHORIZE ')) {
          authorizationUrl = new URL(line.slice('DOOP_TEST_AUTHORIZE '.length))
        }
        if (line.includes('Waiting for authorization')) callbackReady = true
        if (authorizationUrl && callbackReady) {
          const url = authorizationUrl
          authorizationUrl = undefined
          authorization = authorize(url).catch((error: unknown) => {
            browserError = error
            void transport.close()
          })
        }
      })
      try {
        await client.connect(transport)
        await authorization
        expect(browserError).toBeUndefined()
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('create_frame')
        expect(launches).toBe(1)
      } catch (error) {
        throw new Error(`Extension OAuth failed: ${String(browserError ?? error)}\n${diagnostics}`, { cause: error })
      } finally {
        lines.close()
        await client.close()
      }
    }
  } finally {
    await writeFile(opener, original)
  }
}, 30_000)
