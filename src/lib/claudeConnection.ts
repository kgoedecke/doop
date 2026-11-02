import { canUsePublicMcpEndpoint } from './mcpConnection'

type ClaudeExtensionBridge = {
  __DOOP_CLAUDE_EXTENSION__?: boolean
  __TAURI__?: { core: { invoke: (command: string, args: Record<string, unknown>) => Promise<void> } }
}

const bridge = globalThis as ClaudeExtensionBridge
export const canAddToClaudeDesktop = () => bridge.__DOOP_CLAUDE_EXTENSION__ === true && !!bridge.__TAURI__?.core

/** Claude's cloud must be able to reach this URL. Don't offer a broken install
 * link for localhost, private IPs or the usual internal-only hostnames. */
export function claudeConnectorInstallUrl(mcpUrl: string): string | null {
  if (!canUsePublicMcpEndpoint(mcpUrl)) return null
  const install = new URL('https://claude.ai/customize/connectors')
  install.searchParams.set('modal', 'add-custom-connector')
  install.searchParams.set('connectorName', 'Doop')
  install.searchParams.set('connectorUrl', new URL(mcpUrl).href)
  return install.href
}

export async function addToClaudeDesktop(mcpUrl: string): Promise<void> {
  if (!canAddToClaudeDesktop()) throw new Error('Update the Doop desktop app to add Claude directly.')
  const response = await fetch('/claude-extension/doop.mcpb')
  if (!response.ok) throw new Error('Could not prepare the Claude connection. Please try again.')
  const { default: JSZip } = await import('jszip')
  const bundle = await JSZip.loadAsync(await response.arrayBuffer())
  const manifestFile = bundle.file('manifest.json')
  if (!manifestFile) throw new Error('The Claude extension is incomplete. Please try again after updating Doop.')
  const manifest = JSON.parse(await manifestFile.async('string'))
  // The native handoff is already specific to this Doop instance. Prefill its
  // URL so self-hosted and local users don't have to copy one into Claude.
  manifest.user_config.server_url.default = mcpUrl
  bundle.file('manifest.json', JSON.stringify(manifest, null, 2))
  const bytes = await bundle.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
  await bridge.__TAURI__!.core.invoke('claude_add_extension', { bundle: Array.from(bytes) })
}
