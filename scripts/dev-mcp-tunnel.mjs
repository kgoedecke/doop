// Expose only run-scoped MCP routes while keeping local sign-in on localhost.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

const backendPort = Number(process.env.PORT || 4400)
const proxy = http.createServer((req, res) => {
  if (!/^\/local-agent\/mcp\/[A-Za-z0-9_-]+$/.test(req.url || '')) {
    res.writeHead(404).end()
    return
  }
  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: backendPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${backendPort}` },
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const tunnel = spawn(
  'cloudflared',
  ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${proxy.address().port}`],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
let configured = false
let pending = ''
tunnel.stderr.on('data', (chunk) => {
  pending = (pending + chunk.toString()).slice(-16000)
  const origin = pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]
  if (origin && !configured) {
    configured = true
    void (async () => {
      const path = new URL('../.env', import.meta.url)
      const current = await readFile(path, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      const line = `CLAUDE_REMOTE_MCP_ORIGIN=${origin}`
      const next = /^CLAUDE_REMOTE_MCP_ORIGIN=.*$/m.test(current)
        ? current.replace(/^CLAUDE_REMOTE_MCP_ORIGIN=.*$/m, line)
        : `${current.trimEnd()}\n${line}\n`
      await writeFile(path, next, { mode: 0o600 })
      console.log(
        `MCP tunnel: ${origin}\nUpdated .env. Restart the Doop backend, then retry the card.\nKeep this process running while hosted Claude works. Ctrl-C stops the tunnel.`,
      )
    })().catch((error) => {
      console.error(error.message)
      tunnel.kill()
    })
  }
})
tunnel.on('error', (error) => {
  console.error(error.message)
  proxy.close()
  process.exitCode = 1
})
tunnel.on('exit', (code) => {
  proxy.close()
  proxy.closeAllConnections()
  if (code) {
    console.error(pending)
    process.exitCode = code
  }
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    tunnel.kill('SIGTERM')
    proxy.close()
    proxy.closeAllConnections()
  })
