function development() {
  // `bun run dev` leaves NODE_ENV unset; unknown environments fail closed.
  return process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'development'
}

function bareOrigin(url: URL) {
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
}

function localRuntime(url: URL) {
  return (
    development() &&
    bareOrigin(url) &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
}

export function claudeRuntimeOrigin(value: string): URL {
  const url = new URL(value)
  if (!bareOrigin(url) || (url.protocol !== 'https:' && !localRuntime(url)))
    throw new Error('CLAUDE_REMOTE_URL must be an HTTPS origin, or an HTTP loopback origin in development.')
  return url
}

export function claudeMcpOrigin(value: string): URL {
  const url = new URL(value)
  let local = false
  if (development() && process.env.CLAUDE_REMOTE_URL) {
    try {
      local = localRuntime(new URL(process.env.CLAUDE_REMOTE_URL))
    } catch {
      // Invalid runtime configuration must not enable HTTP callbacks.
    }
  }
  if (
    !bareOrigin(url) ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && url.hostname === 'host.docker.internal'))
  )
    throw new Error(
      'CLAUDE_REMOTE_MCP_ORIGIN must be an HTTPS origin for remote Cantelop (use a tunnel for local Doop), or http://host.docker.internal:4400 with a local HTTP Cantelop runtime in development.',
    )
  return url
}
