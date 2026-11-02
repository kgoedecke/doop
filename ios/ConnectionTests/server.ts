const html = '<p>' + 'x'.repeat(2 * 1024 * 1024) + '</p>'
const attempts = new Map<string, number>()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: { cert: Bun.file(process.argv[2]), key: Bun.file(process.argv[3]) },
  fetch(request, server) {
    const path = new URL(request.url).pathname
    if (path.startsWith('/attempts/')) return Response.json(attempts.get(path.slice('/attempts/'.length)) ?? 0)
    if (server.upgrade(request)) return
    return new Response('WebSocket test fixture')
  },
  websocket: {
    // Let the oversized fixture reach the client instead of hitting the
    // server's send-buffer limit first.
    backpressureLimit: 128 * 1024 * 1024,
    message(socket, raw) {
      const message = JSON.parse(String(raw))
      if (message.type !== 'join') return
      const id = message.canvasId
      const count = (attempts.get(id) ?? 0) + 1
      attempts.set(id, count)
      if (id === 'missing') return socket.close(4404, 'not found')
      if (id === 'malformed') return socket.send(JSON.stringify({ type: 'init', canvas: 'invalid' }))
      if (id === 'retry' && count === 1) return socket.close(1011, 'transient fixture failure')
      if (id === 'comments') {
        const comment = {
          id: 'canvas-comment',
          canvasId: id,
          pageId: 'page',
          x: 10,
          y: 20,
          selector: '',
          snippet: '',
          from: 'Web',
          text: 'Canvas pin',
          at: 1,
        }
        socket.send(
          JSON.stringify({
            type: 'init',
            canvas: { id, name: 'Comments', frames: [] },
            tasks: [],
            presences: [],
            comments: [comment],
          }),
        )
        socket.send(
          JSON.stringify({
            type: 'comment',
            comment: { ...comment, id: 'reply', parentId: comment.id, text: 'Reply', at: 2 },
          }),
        )
        socket.send(JSON.stringify({ type: 'comment', comment: { ...comment, resolvedAt: 20 } }))
        socket.send(
          JSON.stringify({
            type: 'comment',
            comment: { ...comment, id: 'frame-comment', frameId: 'f', text: 'Element pin', at: 3 },
          }),
        )
        socket.send(JSON.stringify({ type: 'canvas:renamed', name: 'Still live' }))
        return
      }
      const frameHTML = id === 'oversized' ? 'x'.repeat(64 * 1024 * 1024 + 1) : html
      socket.send(
        JSON.stringify({
          type: 'init',
          canvas: {
            id,
            name: `Attempt ${count}`,
            frames: [{ id: 'f', canvasId: id, name: 'Frame', x: 0, y: 0, width: 390, height: 844, html: frameHTML }],
          },
          tasks: [],
          comments: [],
          presences: [],
        }),
      )
    },
  },
})
console.log(server.port)
