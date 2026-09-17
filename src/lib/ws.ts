import type { ClientMessage, ServerMessage } from '../../shared/types'
import { getIdentity } from './identity'
import { useStore } from './store'

let socket: WebSocket | null = null
let currentCanvasId: string | null = null
let retryTimer: number | null = null
/* the server build this page first connected under; survives reconnects */
let loadedBuild: string | null = null

export function connect(canvasId: string) {
  currentCanvasId = canvasId
  /* a fresh attempt for a (possibly different) id — any not-found from a
     previous canvas must not leak into this one */
  useStore.getState().setCanvasNotFound(false)
  open()
}

export function disconnect() {
  currentCanvasId = null
  if (retryTimer) window.clearTimeout(retryTimer)
  socket?.close()
  socket = null
}

export function sendWs(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

function open() {
  if (!currentCanvasId) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const s = new WebSocket(`${proto}://${location.host}/ws`)
  socket = s
  const canvasId = currentCanvasId

  s.onopen = () => {
    if (socket !== s) return
    const { clientId, name } = getIdentity()
    useStore.getState().setConnected(true)
    sendWs({ type: 'join', canvasId, clientId, name, kind: 'user' })
  }

  s.onmessage = (ev) => {
    if (socket !== s) return
    let msg: ServerMessage
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    handle(msg)
  }

  s.onclose = (ev) => {
    /* a superseded socket must not trigger reconnects */
    if (socket !== s) return
    useStore.getState().setConnected(false)
    if (ev.code === 4401) {
      /* session expired or missing — reload lands on the sign-in page */
      currentCanvasId = null
      location.reload()
      return
    }
    if (ev.code === 4403) {
      /* the owner locked this canvas — retrying would loop forever */
      currentCanvasId = null
      location.href = '/'
      return
    }
    if (ev.code === 4404) {
      /* no such canvas — a typo'd id, or one that was just deleted. Stop
         retrying (there is nothing to reconnect to) and let CanvasPage show
         a not-found screen instead of an unresponsive, empty canvas UI. */
      currentCanvasId = null
      useStore.getState().setCanvasNotFound(true)
      return
    }
    if (currentCanvasId) {
      retryTimer = window.setTimeout(open, 1200)
    }
  }
}

function handle(msg: ServerMessage) {
  const s = useStore.getState()
  const me = getIdentity().clientId
  switch (msg.type) {
    case 'init':
      /* a reconnect that lands on a different build means this page is
         running a stale bundle — offer a reload instead of forcing one,
         so in-progress work is never yanked away */
      if (msg.serverBuild !== 'dev') {
        if (loadedBuild === null) loadedBuild = msg.serverBuild
        else if (loadedBuild !== msg.serverBuild) s.setUpdateReady(true)
      }
      s.setCanvas(msg.canvas)
      s.setPresences(msg.presences)
      s.setActivity(msg.activity)
      s.setTasks(msg.tasks)
      s.setFeedback(msg.feedback)
      s.setComments(msg.comments)
      s.setDecisions(msg.decisions)
      s.setProposals(msg.proposals)
      break
    case 'presence:join':
      if (msg.presence.clientId !== me) s.upsertPresence(msg.presence)
      break
    case 'presence:leave':
      s.removePresence(msg.clientId)
      break
    case 'cursor':
      s.setCursor(msg.clientId, msg.x, msg.y)
      break
    case 'editing':
      s.setEditing(msg.clientId, msg.frameId)
      break
    case 'status':
      s.setStatus(msg.clientId, msg.status)
      break
    case 'task':
      s.upsertTask(msg.task)
      break
    case 'feedback':
      s.upsertFeedback(msg.feedback)
      break
    case 'comment':
      s.upsertComment(msg.comment)
      break
    case 'frame:drag':
      s.patchFrameLocal(msg.frameId, { x: msg.x, y: msg.y, width: msg.width, height: msg.height })
      break
    case 'frame:created':
      s.upsertFrame(msg.frame)
      if (msg.actor.clientId !== me) s.flash(msg.frame.id, msg.actor.color)
      break
    case 'frame:updated':
      s.upsertFrame(msg.frame)
      /* during a live stream the marching border replaces per-chunk flashes */
      if (msg.actor.clientId !== me && !s.streams[msg.frame.id]) s.flash(msg.frame.id, msg.actor.color)
      break
    case 'frame:streaming':
      s.setStream(msg.frameId, msg.active ? { name: msg.actor.name, color: msg.actor.color } : null)
      break
    case 'frame:deleted':
      s.removeFrame(msg.frameId)
      break
    case 'canvas:renamed':
      s.renameCanvasLocal(msg.name)
      break
    case 'guidelines':
      s.setGuidelineLocal(msg.name, msg.doc)
      break
    case 'reference':
      s.setReferenceLocal(msg.id, msg.reference)
      break
    case 'decision':
      s.pushDecision(msg.decision)
      break
    case 'proposal':
      s.upsertProposal(msg.proposal)
      break
    case 'canvas:deleted':
      /* the room only receives this for the canvas it's viewing */
      location.href = '/'
      break
    case 'activity':
      s.pushActivity(msg.item)
      break
  }
}
