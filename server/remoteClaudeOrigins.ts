function development() {
  // `bun run dev` leaves NODE_ENV unset; unknown environments fail closed.
  return process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'development'
}

function bareOrigin(url: URL) {
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
}

export function claudeMcpOrigin(value: string): URL {
  const url = new URL(value)
  if (
    !bareOrigin(url) ||
    (url.protocol !== 'https:' &&
      !(development() && url.protocol === 'http:' && url.hostname === 'host.docker.internal'))
  )
    throw new Error(
      'CLAUDE_REMOTE_MCP_ORIGIN must be an HTTPS origin, or an HTTP host.docker.internal origin in development.',
    )
  return url
}
