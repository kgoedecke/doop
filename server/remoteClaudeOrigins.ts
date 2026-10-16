import { env } from './env.ts'

function bareOrigin(url: URL) {
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
}

export function claudeMcpOrigin(value: string): URL {
  const url = new URL(value)
  if (
    !bareOrigin(url) ||
    (url.protocol !== 'https:' && !(env.isDev && url.protocol === 'http:' && url.hostname === 'host.docker.internal'))
  )
    throw new Error(
      'CLAUDE_REMOTE_MCP_ORIGIN must be an HTTPS origin, or an HTTP host.docker.internal origin in development.',
    )
  return url
}
