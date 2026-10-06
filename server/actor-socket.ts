import http, { type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Request } from 'express'
import type { SocketGrant } from 'terse-sdk/actors'

const socketPath = '/api/actors/socket'

/** Local runtime ports stay private; browsers use the app's published port. */
export function browserActorGrant(grant: SocketGrant, req: Request): SocketGrant {
  if (!process.env.DOOP_LOCAL_ACTOR_URL) return grant
  const url = new URL(socketPath, `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}`)
  url.search = new URL(grant.websocketUrl).search
  return { ...grant, websocketUrl: url.toString() }
}

export function upgradeActorSocket(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const origin = process.env.DOOP_LOCAL_ACTOR_URL
  const incoming = new URL(req.url ?? '/', 'http://localhost')
  if (!origin || incoming.pathname !== socketPath) return false
  const target = new URL('/v1/socket', origin)
  target.search = incoming.search
  // The runtime validates the short-lived, actor-scoped ticket before upgrading.
  const upstream = http.request(target, { headers: { ...req.headers, host: target.host } })
  socket.once('close', () => upstream.destroy())
  socket.once('error', () => upstream.destroy())
  upstream.once('error', () => socket.destroy())
  upstream.setTimeout(10_000, () => upstream.destroy())
  upstream.once('response', (response) => {
    response.resume()
    socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  upstream.once('upgrade', (response, peer, pending) => {
    upstream.setTimeout(0)
    const headers = response.rawHeaders.flatMap((name, i, all) => (i % 2 ? [] : [`${name}: ${all[i + 1]}`]))
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`)
    if (pending.length) socket.write(pending)
    if (head.length) peer.write(head)
    peer.once('error', () => socket.destroy())
    peer.once('close', () => socket.destroy())
    socket.once('close', () => peer.destroy())
    socket.pipe(peer).pipe(socket)
  })
  upstream.end()
  return true
}
