function privateIpv4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/** Only called with a URL-normalized IPv6 literal (without its brackets). */
function privateIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true
  // URL normalizes IPv4-mapped addresses to hex, including dotted input.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16)
    const lo = parseInt(mapped[2]!, 16)
    return privateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  const first = parseInt(host.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

/** Filter common local endpoints before offering a cloud connector. This is
 * setup guidance, not a network access boundary: the client checks reachability. */
export function canUsePublicMcpEndpoint(mcpUrl: string): boolean {
  const url = new URL(mcpUrl)
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[')) return !privateIpv6(host.slice(1, -1))
  // Prefixes like 10. can also begin public DNS names. Check only IP literals.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !privateIpv4(host)
  return host.includes('.') && !/(^|\.)(localhost|local|internal|lan|test|invalid|home\.arpa)$/.test(host)
}
