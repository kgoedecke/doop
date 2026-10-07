// HTTPS front door for a local doop server, for iOS simulator testing.
// The iOS app only accepts https:// origins, so this terminates TLS on
// https://localhost:18443 and forwards HTTP and WebSocket traffic to the dev
// server on http://localhost:4400 (override with DOOP_UPSTREAM). Trust the CA in
// the simulator with: xcrun simctl keychain booted add-root-cert ca.pem
//   node ios/scripts/local-https.mjs <cert.pem> <key.pem> [port]
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'

const [, , certPath, keyPath, portArg] = process.argv
if (!certPath || !keyPath) {
  console.error('usage: node ios/scripts/local-https.mjs <cert.pem> <key.pem> [port]')
  process.exit(2)
}
const port = Number(portArg || 18443)
const upstream = new URL(process.env.DOOP_UPSTREAM || 'http://localhost:4400')

const server = https.createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
  const proxied = http.request(
    {
      host: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `localhost:${port}` },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    },
  )
  proxied.on('error', (err) => {
    res.writeHead(502)
    res.end(String(err))
  })
  req.pipe(proxied)
})

// WebSocket rooms: splice the TLS socket onto a raw upstream TCP connection.
server.on('upgrade', (req, socket, head) => {
  const target = net.connect(Number(upstream.port), upstream.hostname, () => {
    const headers = Object.entries({ ...req.headers, host: `localhost:${port}` })
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n')
    target.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`)
    if (head.length) target.write(head)
    socket.pipe(target).pipe(socket)
  })
  const drop = () => {
    socket.destroy()
    target.destroy()
  }
  target.on('error', drop)
  socket.on('error', drop)
})

server.listen(port, () => console.log(`https://localhost:${port} -> ${upstream.origin}`))
