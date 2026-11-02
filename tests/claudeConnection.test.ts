import JSZip from 'jszip'
import { afterEach, expect, it, vi } from 'vitest'
import { addToClaudeDesktop, claudeConnectorInstallUrl } from '../src/lib/claudeConnection'

afterEach(() => vi.unstubAllGlobals())

it('uses Claude’s documented install link and preserves the exact server URL', () => {
  const server = 'https://design.example.com/mcp?workspace=design&team=a'
  const link = new URL(claudeConnectorInstallUrl(server)!)
  expect(link.origin + link.pathname).toBe('https://claude.ai/customize/connectors')
  expect(link.searchParams.get('connectorUrl')).toBe(server)
  expect(link.searchParams.get('connectorName')).toBe('Doop')
  expect(link.searchParams.get('modal')).toBe('add-custom-connector')
})

it.each([
  'https://10.design.example.com/mcp',
  'https://127.design.example.com/mcp',
  'https://192.168.design.example.com/mcp',
  'https://8.8.8.8/mcp',
  'https://[2606:4700:4700::1111]/mcp',
  'https://[::ffff:8.8.8.8]/mcp',
])('keeps online setup available for a public host: %s', (server) => {
  const link = new URL(claudeConnectorInstallUrl(server)!)
  expect(link.searchParams.get('connectorUrl')).toBe(new URL(server).href)
})

it.each([
  'http://localhost:4301/mcp',
  'https://127.0.0.1/mcp',
  'https://192.168.1.5/mcp',
  'https://172.20.1.1/mcp',
  'https://[::1]/mcp',
  'https://[0:0:0:0:0:0:0:1]/mcp',
  'https://[::]/mcp',
  'https://[fc00::1]/mcp',
  'https://[fd12:3456::1]/mcp',
  'https://[fe80::1]/mcp',
  'https://[febf::1]/mcp',
  'https://[::ffff:192.168.1.5]/mcp',
  'https://[::ffff:7f00:1]/mcp',
  'https://100.64.0.1/mcp',
  'https://localhost./mcp',
  'https://design.home.arpa/mcp',
  'https://design.local/mcp',
  'http://design.example.com/mcp',
])('does not send an unreachable local URL to Claude’s cloud: %s', (url) => {
  expect(claudeConnectorInstallUrl(url)).toBeNull()
})

it('prefills the local server and hands the complete bundle to the shell without a download link', async () => {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify({ user_config: { server_url: { default: 'https://doop.design/mcp' } } }))
  zip.file('node_modules/proxy.js', 'runtime')
  const fetcher = vi.fn().mockResolvedValue(new Response(await zip.generateAsync({ type: 'arraybuffer' })))
  const invoke = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('__DOOP_CLAUDE_EXTENSION__', true)
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  await addToClaudeDesktop('http://localhost:4301/mcp')
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/claude-extension/doop.mcpb')
  expect(invoke).toHaveBeenCalledOnce()
  const [command, payload] = invoke.mock.calls[0] as [string, { bundle: number[] }]
  expect(command).toBe('claude_add_extension')
  const prepared = await JSZip.loadAsync(new Uint8Array(payload.bundle))
  const manifest = JSON.parse(await prepared.file('manifest.json')!.async('string'))
  expect(manifest.user_config.server_url.default).toBe('http://localhost:4301/mcp')
  expect(await prepared.file('node_modules/proxy.js')!.async('string')).toBe('runtime')
})

it('does not invoke the shell when preparing the bundle fails', async () => {
  const invoke = vi.fn()
  vi.stubGlobal('__DOOP_CLAUDE_EXTENSION__', true)
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 })))
  await expect(addToClaudeDesktop('https://doop.design/mcp')).rejects.toThrow('Could not prepare')
  expect(invoke).not.toHaveBeenCalled()
})

it('keeps older shells from invoking an unavailable native command', async () => {
  vi.stubGlobal('__DOOP_CLAUDE_EXTENSION__', undefined)
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(addToClaudeDesktop('https://doop.design/mcp')).rejects.toThrow('Update the Doop desktop app')
  expect(fetcher).not.toHaveBeenCalled()
})
