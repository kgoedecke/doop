/** Cursor's documented MCP install link carries one server config, not mcpServers.
 * https://cursor.com/docs/mcp/install-links */
export function cursorMcpInstallUrl(mcpUrl: string): string {
  const link = new URL('cursor://anysphere.cursor-deeplink/mcp/install')
  link.searchParams.set('name', 'doop')
  link.searchParams.set('config', btoa(JSON.stringify({ url: new URL(mcpUrl).href })))
  return link.href
}
