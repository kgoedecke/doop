import { readFile, realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import {
  localSourceOrigin,
  SOURCE_CANVAS_PATH,
  sourceChange,
  sourceId,
  sourceProject,
  type SourceCard,
} from '../shared/sourceCanvas.ts'
import { editSourceTarget, sourceTarget } from './sourceJsx.ts'
import { replaceLocalSource, SOURCE_RECOVERY_DIR } from './sourceDisk.ts'

type Entry = SourceCard & { entry: string; source: string }
type SourceCanvasOptions = { doopOrigin: string; name: string; cards: Entry[] }

function sourcePath(file: string) {
  if (
    !/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.[jt]sx$/.test(file) ||
    file.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Error('Source canvas files must be project-relative .jsx or .tsx paths')
  }
  return file
}

function localSocket(address: string | undefined) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readChange(req: IncomingMessage) {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > 8192) return null
    chunks.push(chunk)
  }
  try {
    return sourceChange.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch {
    return null
  }
}

function previewBridge(doopOrigin: string) {
  return `(() => {
  const origin = ${JSON.stringify(doopOrigin)}
  const send = (data) => parent.postMessage(data, origin)
  let inspect = parent !== window
  let selected = null
  let hovered = null
  const mark = (element) => element instanceof Element ? element.closest('[data-doop-edit]') : null
  const paint = () => {
    for (const element of document.querySelectorAll('[data-doop-source-highlight]')) {
      element.removeAttribute('data-doop-source-highlight')
    }
    if (!inspect) return
    for (const element of document.querySelectorAll('[data-doop-edit]')) {
      if (element.getAttribute('data-doop-edit') === selected || element === hovered) {
        element.setAttribute('data-doop-source-highlight', '')
      }
    }
  }
  addEventListener('message', (event) => {
    if (event.origin !== origin || event.source !== parent || event.data?.type !== 'doop-source:mode') return
    inspect = event.data.inspect === true
    selected = typeof event.data.marker === 'string' ? event.data.marker : null
    hovered = null
    paint()
  })
  addEventListener('pointermove', (event) => {
    if (!inspect) return
    event.stopImmediatePropagation()
    const element = mark(event.target)
    if (hovered === element) return
    hovered = element
    paint()
  }, true)
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'dragstart']) {
    addEventListener(type, (event) => {
      if (!inspect || !event.isTrusted) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }, true)
  }
  addEventListener('contextmenu', (event) => {
    if (!inspect || !event.isTrusted) return
    event.preventDefault()
    event.stopImmediatePropagation()
    send({ type: 'doop-source:context-menu', x: event.clientX, y: event.clientY })
  }, true)
  addEventListener('click', (event) => {
    if (!inspect || !event.isTrusted) return
    event.preventDefault()
    event.stopImmediatePropagation()
    send({ type: 'doop-source:select', marker: mark(event.target)?.getAttribute('data-doop-edit') ?? null })
  }, true)
  addEventListener('wheel', (event) => {
    if (!inspect || !event.isTrusted) return
    event.preventDefault()
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1
    send({
      type: 'doop-source:wheel', x: event.clientX, y: event.clientY,
      dx: (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit,
      dy: (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit,
      zoom: event.ctrlKey || event.metaKey,
    })
  }, { passive: false, capture: true })
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && event.isTrusted) send({ type: 'doop-source:escape' })
  })
  if (parent !== window) send({ type: 'doop-source:ready' })
})()`
}

export function doopSourceCanvas(options: SourceCanvasOptions): Plugin {
  const doopOrigin = localSourceOrigin(options.doopOrigin)
  if (!doopOrigin) throw new Error('Source canvas requires a loopback HTTP Doop origin')
  const manifest = sourceProject.parse({ version: 1, name: options.name, cards: options.cards })
  const entries = new Map(
    options.cards.map((card) => [card.id, { entry: sourcePath(card.entry), source: sourcePath(card.source) }]),
  )
  if (entries.size !== options.cards.length) throw new Error('Source canvas card IDs must be unique')
  const virtual = 'virtual:doop-source:'
  const busy = new Set<string>()

  async function readTarget(server: ViteDevServer, card: string, marker: string) {
    const item = entries.get(card)
    if (!item) return null
    const root = await realpath(server.config.root)
    const file = await realpath(path.resolve(root, item.source))
    const relative = path.relative(root, file)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null
    const source = await readFile(file, 'utf8')
    const target = sourceTarget(file, source, marker)
    return target ? { item, root, file, source, target } : null
  }

  const handle = async (server: ViteDevServer, req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const endpoint = url.pathname.slice(SOURCE_CANVAS_PATH.length)
    const host = localSourceOrigin('http://' + (req.headers.host ?? ''))
    if (
      !host ||
      host === doopOrigin ||
      !localSocket(req.socket.remoteAddress) ||
      !localSocket(req.socket.localAddress)
    ) {
      return json(res, 403, { error: 'Source preview requires two separate local origins' })
    }
    const preview = /^\/view\/([a-zA-Z][a-zA-Z0-9_-]{0,79})$/.exec(endpoint)?.[1]
    if (req.method === 'GET' && preview && entries.has(preview)) {
      const page = await server.transformIndexHtml(
        url.pathname,
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0}html{overscroll-behavior:contain}[data-doop-source-highlight]{outline:2px solid #137fdf!important;outline-offset:-2px!important}</style>
        <script>${previewBridge(doopOrigin)}</script></head><body><div id="root"></div>
        <script type="module" src="/@id/${virtual}${preview}"></script></body></html>`,
      )
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `frame-ancestors ${doopOrigin}`,
        'Cache-Control': 'no-store',
      })
      return res.end(page)
    }
    if (req.headers.origin !== doopOrigin) return json(res, 403, { error: 'Doop origin not trusted by this project' })
    res.setHeader('Access-Control-Allow-Origin', doopOrigin)
    res.setHeader('Vary', 'Origin')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type, X-Doop-Source',
        'Access-Control-Allow-Methods': 'GET, POST',
      })
      return res.end()
    }
    if (req.method === 'GET' && endpoint === '/project') return json(res, 200, manifest)
    if (req.method === 'GET' && endpoint === '/selection') {
      const card = sourceId.safeParse(url.searchParams.get('card'))
      const marker = sourceId.safeParse(url.searchParams.get('marker'))
      if (!card.success || !marker.success) return json(res, 400, { error: 'Invalid element reference' })
      const hit = await readTarget(server, card.data, marker.data)
      if (!hit) return json(res, 404, { error: 'Marker must appear once in the configured JSX source' })
      const { line, revision, text, color } = hit.target
      return json(res, 200, { file: hit.item.source, line, revision, text: text?.value, color: color?.value })
    }
    if (req.method === 'POST' && endpoint === '/edit') {
      if (req.headers['x-doop-source'] !== '1' || req.headers['content-type'] !== 'application/json') {
        return json(res, 400, { error: 'Expected a Doop source edit' })
      }
      const change = await readChange(req)
      if (!change) return json(res, 400, { error: 'Invalid source edit' })
      const hit = await readTarget(server, change.card, change.marker)
      if (!hit) return json(res, 404, { error: 'The selected source element no longer exists' })
      const conflict = () =>
        json(res, 409, {
          error: 'File changed on disk. Reselect the element. If needed, check .doop-source-recovery for a copy.',
        })
      if (hit.target.revision !== change.revision || busy.has(hit.file)) return conflict()
      const updated = editSourceTarget(hit.source, hit.target, change.fields)
      if (updated === null) return json(res, 422, { error: 'This field is not a supported JSX literal' })
      if (updated === hit.source) return json(res, 200, { saved: true })
      busy.add(hit.file)
      try {
        if (!(await replaceLocalSource(hit.root, hit.file, hit.source, updated))) return conflict()
      } finally {
        busy.delete(hit.file)
      }
      return json(res, 200, { saved: true })
    }
    return json(res, 404, { error: 'Unknown source canvas request' })
  }

  return {
    name: 'doop-source-canvas',
    apply: 'serve',
    config(config) {
      const deny = config.server?.fs?.deny ?? ['.env', '.env.*', '*.{crt,pem}', '**/.git/**']
      return { server: { fs: { deny: [...deny, `**/${SOURCE_RECOVERY_DIR}/**`] } } }
    },
    resolveId(id) {
      if (id.startsWith(virtual) && entries.has(id.slice(virtual.length))) return '\0' + id
    },
    load(id) {
      if (!id.startsWith('\0' + virtual)) return
      const item = entries.get(id.slice(virtual.length + 1))
      if (!item) return
      return `import { createElement } from 'react'
        import { createRoot } from 'react-dom/client'
        import Card from ${JSON.stringify('/' + item.entry)}
        createRoot(document.getElementById('root')).render(createElement(Card))`
    },
    configureServer(server) {
      const host = server.config.server.host
      if (host !== undefined && host !== false && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        throw new Error('Doop source canvas can only be used on a loopback Vite server')
      }
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(SOURCE_CANVAS_PATH + '/')) return next()
        void handle(server, req, res).catch(() => {
          if (!res.headersSent) json(res, 500, { error: 'Could not read or save the project JSX source' })
          else if (!res.writableEnded) res.end()
        })
      })
    },
  }
}
