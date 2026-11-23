import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { z, type ZodType } from 'zod'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { initTheme } from './lib/theme'
import { cn } from './lib/utils'
import {
  localSourceOrigin,
  SOURCE_CANVAS_PATH,
  sourceColor,
  sourcePreviewEvent,
  sourceProject,
  sourceSelection,
  type SourceCard,
} from '../shared/sourceCanvas'
import './styles.css'

const LOCAL_PROJECT = 'doop:local-source-project'
const savedResponse = z.object({ saved: z.literal(true) })

type Project = z.infer<typeof sourceProject>
type Selection = z.infer<typeof sourceSelection>
type Picked = { card: string; marker: string }
type Position = { x: number; y: number; zoom: number }
type Wheel = { x: number; y: number; dx: number; dy: number; zoom: boolean }

function syncPreviewMode(iframe: HTMLIFrameElement, origin: string, inspect: boolean, marker: string | null) {
  iframe.contentWindow?.postMessage({ type: 'doop-source:mode', inspect, marker }, origin)
}

async function projectRequest<T>(origin: string, path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(origin + SOURCE_CANVAS_PATH + path, {
    ...init,
    credentials: 'omit',
    redirect: 'error',
  })
  const body: unknown = await response.json()
  if (!response.ok) {
    const failure = z.object({ error: z.string() }).safeParse(body)
    throw new Error(failure.success ? failure.data.error : 'The local project request failed')
  }
  return schema.parse(body)
}

function SourceInspector({
  marker,
  selected,
  onSave,
}: {
  marker: string
  selected: Selection
  onSave: (fields: { text?: string; color?: string }) => Promise<void>
}) {
  const [text, setText] = useState(selected.text ?? '')
  const [color, setColor] = useState(selected.color ?? '')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [status, setStatus] = useState('')
  const changed =
    (selected.text !== undefined && text !== selected.text) ||
    (selected.color !== undefined && color !== selected.color)
  const [busy, setBusy] = useState(false)
  const reference = `${selected.file}:${selected.line}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `In the local project, edit the React element at ${reference} (data-doop-edit="${marker}").\n\n${agentPrompt.trim() || 'Keep the existing behavior and update the JSX in place.'}`,
      )
      setStatus('Copied for your local coding agent.')
    } catch {
      setStatus('Clipboard unavailable. Use the file and line above in your agent.')
    }
  }

  async function save() {
    if (busy || !changed) return
    setBusy(true)
    setStatus('')
    try {
      await onSave({
        ...(selected.text !== undefined && text !== selected.text && { text }),
        ...(selected.color !== undefined && color !== selected.color && { color }),
      })
      setStatus('Saved to JSX.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save your source edit')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="break-all font-mono text-caption text-ink-soft">{reference}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {selected.text !== undefined && (
          <label className="grid gap-1 text-label font-medium">
            Text
            <Input value={text} maxLength={1000} onChange={(event) => setText(event.target.value)} />
          </label>
        )}
        {selected.color !== undefined && (
          <label className="grid gap-1 text-label font-medium">
            Text color
            <Input value={color} maxLength={7} onChange={(event) => setColor(event.target.value)} />
          </label>
        )}
        {selected.text === undefined && selected.color === undefined ? (
          <p className="text-body text-ink-soft">This element has no supported static JSX fields. Edit it in code.</p>
        ) : (
          <Button
            type="submit"
            variant="primary"
            disabled={!changed || busy || (selected.color !== undefined && !sourceColor.safeParse(color).success)}
          >
            {busy ? 'Saving…' : 'Save to source'}
          </Button>
        )}
      </form>
      <div className="grid gap-2 border-t border-line pt-4">
        <label className="grid gap-1 text-label font-medium">
          Ask a coding agent
          <Input
            placeholder="What should change?"
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
          />
        </label>
        <Button variant="ghost" onClick={() => void copy()}>
          Copy prompt with source reference
        </Button>
        <p className="text-caption text-ink-soft">
          Paste into your coding agent in the project. Saved code changes appear here.
        </p>
      </div>
      {status && (
        <p role="status" className="text-body text-ink-soft">
          {status}
        </p>
      )}
    </div>
  )
}

function LocalCanvas() {
  const [connection, setConnection] = useState(() => ({
    origin: localStorage.getItem(LOCAL_PROJECT) ?? '',
    nonce: 0,
  }))
  const [address, setAddress] = useState(connection.origin)
  const [project, setProject] = useState<Project | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [offline, setOffline] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [target, setTarget] = useState<Selection | null>(null)
  const [targetError, setTargetError] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [position, setPosition] = useState<Position>({ x: 64, y: 72, zoom: 0.8 })
  const [revision, setRevision] = useState(0)
  const stage = useRef<HTMLElement>(null)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null)
  const { origin } = connection

  function transition(next: string) {
    setProject(null)
    setConnectionError('')
    setOffline(false)
    setPicked(null)
    setTarget(null)
    setTargetError('')
    setPlaying(null)
    setConnection((current) => ({ origin: next, nonce: current.nonce + 1 }))
    if (next) localStorage.setItem(LOCAL_PROJECT, next)
    else localStorage.removeItem(LOCAL_PROJECT)
  }

  useEffect(() => {
    const { origin } = connection
    if (!origin || localSourceOrigin(origin) !== origin || origin === location.origin) return
    const controller = new AbortController()
    void projectRequest(origin, '/project', sourceProject, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    }).then(
      (next) => {
        if (!controller.signal.aborted) setProject(next)
      },
      () => {
        if (!controller.signal.aborted)
          setConnectionError('No compatible Doop connector found. Check the server address and trusted Doop origin.')
      },
    )
    return () => controller.abort()
  }, [connection])

  useEffect(() => {
    if (!project) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void projectRequest(origin, '/project', sourceProject, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      }).then(
        () => {
          if (!controller.signal.aborted) setOffline(false)
        },
        () => {
          if (!controller.signal.aborted) setOffline(true)
        },
      )
    }, 5000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [origin, project])

  useEffect(() => {
    if (!picked || !project) return
    const controller = new AbortController()
    const query = new URLSearchParams(picked)
    void projectRequest(origin, '/selection?' + query, sourceSelection, { signal: controller.signal }).then(
      (next) => {
        if (controller.signal.aborted) return
        setTarget(next)
        setTargetError('')
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setTarget(null)
        setTargetError(error instanceof Error ? error.message : 'Could not read this source element')
      },
    )
    return () => controller.abort()
  }, [origin, picked, project, revision])

  function moveCamera(wheel: Wheel) {
    setPosition((at) => {
      if (!wheel.zoom) return { ...at, x: at.x - wheel.dx, y: at.y - wheel.dy }
      const zoom = Math.min(2, Math.max(0.25, at.zoom * Math.exp(-Math.max(-40, Math.min(40, wheel.dy)) * 0.01)))
      const scale = zoom / at.zoom
      return { x: wheel.x - (wheel.x - at.x) * scale, y: wheel.y - (wheel.y - at.y) * scale, zoom }
    })
  }

  useEffect(() => {
    const node = stage.current
    if (!node) return
    function wheel(event: WheelEvent) {
      event.preventDefault()
      const rect = node!.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
      moveCamera({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        dx: (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit,
        dy: (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit,
        zoom: event.ctrlKey || event.metaKey,
      })
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])

  useEffect(() => {
    function setMode(id: string, iframe: HTMLIFrameElement) {
      syncPreviewMode(iframe, origin, playing !== id, picked?.card === id ? picked.marker : null)
    }
    for (const [id, iframe] of frames.current) setMode(id, iframe)
    function message(event: MessageEvent<unknown>) {
      if (event.origin !== origin) return
      const frame = [...frames.current].find(([, iframe]) => iframe.contentWindow === event.source)
      const parsed = sourcePreviewEvent.safeParse(event.data)
      if (!frame || !parsed.success) return
      const [id, iframe] = frame
      const data = parsed.data
      if (data.type === 'doop-source:ready') setMode(id, iframe)
      else if (data.type === 'doop-source:escape') {
        setPlaying(null)
        iframe.blur()
      } else if (playing !== id && data.type === 'doop-source:select') {
        setTarget(null)
        setTargetError('')
        setPicked(data.marker ? { card: id, marker: data.marker } : null)
      } else if (playing !== id && data.type === 'doop-source:wheel') {
        const rect = iframe.getBoundingClientRect()
        const stageRect = stage.current?.getBoundingClientRect()
        if (!stageRect) return
        moveCamera({
          ...data,
          x: rect.left - stageRect.left + (data.x * rect.width) / iframe.offsetWidth,
          y: rect.top - stageRect.top + (data.y * rect.height) / iframe.offsetHeight,
        })
      }
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) setPlaying(null)
    }
    window.addEventListener('message', message)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('message', message)
      window.removeEventListener('keydown', key)
    }
  }, [origin, picked, playing])

  function startPan(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('[data-source-pan]')) return
    if (event.target.closest('button, iframe')) return
    const node = event.currentTarget
    node.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY }
  }

  function pan(event: ReactPointerEvent<HTMLElement>) {
    const last = drag.current
    if (!last || last.pointer !== event.pointerId) return
    drag.current = { pointer: last.pointer, x: event.clientX, y: event.clientY }
    setPosition((at) => ({ ...at, x: at.x + event.clientX - last.x, y: at.y + event.clientY - last.y }))
  }

  function stopPan(event: ReactPointerEvent<HTMLElement>) {
    if (drag.current?.pointer === event.pointerId) drag.current = null
  }

  async function save(fields: { text?: string; color?: string }) {
    if (!picked || !target) return
    await projectRequest(origin, '/edit', savedResponse, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Doop-Source': '1' },
      body: JSON.stringify({ ...picked, revision: target.revision, fields }),
    })
    setRevision((value) => value + 1)
  }

  function cardView(card: SourceCard) {
    const isPlaying = playing === card.id
    return (
      <article key={card.id} className="flex shrink-0 flex-col gap-2" style={{ width: card.width }}>
        <header
          data-source-pan=""
          className="flex cursor-grab items-center justify-between rounded-card bg-surface px-3 py-2 shadow-ring"
        >
          <div className="min-w-0">
            <h2 className="truncate text-body font-semibold">{card.name}</h2>
            <p className="text-caption text-ink-soft">
              {card.width} × {card.height} · Local · Vite
            </p>
          </div>
          <Button
            variant={isPlaying ? 'brand' : 'ghost'}
            size="sm"
            aria-pressed={isPlaying}
            onClick={() => setPlaying(isPlaying ? null : card.id)}
          >
            {isPlaying ? 'Stop playing' : 'Play'}
          </Button>
        </header>
        <iframe
          ref={(iframe) => {
            if (iframe) frames.current.set(card.id, iframe)
            else frames.current.delete(card.id)
          }}
          title={card.name}
          onLoad={(event) =>
            syncPreviewMode(event.currentTarget, origin, !isPlaying, picked?.card === card.id ? picked.marker : null)
          }
          data-source-card={card.id}
          sandbox="allow-scripts allow-same-origin"
          src={origin + SOURCE_CANVAS_PATH + '/view/' + card.id}
          className={cn('block border-0 bg-white shadow-ring', isPlaying && 'outline-2 outline-brand')}
          style={{ width: card.width, height: card.height }}
        />
      </article>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-paper text-ink">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <Button asChild variant="bare" size="sm">
          <a href="/">Doop</a>
        </Button>
        <h1 className="text-lead font-semibold">Local source canvas</h1>
        <span className="text-caption text-ink-soft">{project ? project.name : 'React + Vite'}</span>
        {project && (
          <div className="ml-auto flex items-center gap-2">
            {offline && (
              <Button size="sm" variant="ghost" onClick={() => transition(origin)}>
                Reconnect
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => transition('')}>
              Disconnect
            </Button>
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <main
          ref={stage}
          className="relative min-w-0 flex-1 touch-none overflow-hidden bg-paper"
          onPointerDown={startPan}
          onPointerMove={pan}
          onPointerUp={stopPan}
          onLostPointerCapture={stopPan}
        >
          <div
            data-source-pan=""
            className="absolute inset-0 cursor-grab"
            style={{
              backgroundImage: 'radial-gradient(var(--color-line) 1px, transparent 1px)',
              backgroundSize: `${24 * position.zoom}px ${24 * position.zoom}px`,
              backgroundPosition: `${position.x}px ${position.y}px`,
            }}
          />
          {project ? (
            <>
              <div
                className="pointer-events-none absolute left-0 top-0 flex origin-top-left gap-10 [&>article]:pointer-events-auto"
                data-source-world=""
                style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${position.zoom})` }}
              >
                {project.cards.map(cardView)}
              </div>
              <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-card bg-surface p-1.5 shadow-ring">
                <Button variant="bare" size="sm" onClick={() => setPosition({ x: 64, y: 72, zoom: 0.8 })}>
                  Reset view
                </Button>
                <span className="pr-2 text-caption tabular-nums text-ink-soft">{Math.round(position.zoom * 100)}%</span>
              </div>
            </>
          ) : (
            <div className="absolute left-1/2 top-1/2 grid w-[min(420px,calc(100%-2rem))] -translate-1/2 gap-4 rounded-card bg-surface p-6 shadow-ring">
              <div className="grid gap-2">
                <h2 className="text-lead font-semibold">Connect your React project</h2>
                <p className="text-body text-ink-soft">
                  Start Vite with the Doop source connector, then enter its loopback address. Only connect projects you
                  trust. Source and edits stay on this computer.
                </p>
                <p className="text-caption text-ink-soft">
                  Trusted Doop origin: <code>{location.origin}</code>
                </p>
              </div>
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const next = localSourceOrigin(address.trim())
                  if (!next || next === location.origin) {
                    setConnectionError('Enter a different local HTTP origin, such as http://127.0.0.1:5173.')
                    return
                  }
                  transition(next)
                }}
              >
                <label className="grid gap-1 text-label font-medium">
                  Vite server address
                  <Input
                    value={address}
                    placeholder="http://127.0.0.1:5173"
                    onChange={(event) => setAddress(event.target.value)}
                    required
                  />
                </label>
                <Button variant="primary" type="submit">
                  Connect project
                </Button>
              </form>
              {connectionError && (
                <p role="alert" className="text-body text-accent-ink">
                  {connectionError}
                </p>
              )}
              {!connectionError && origin && (
                <p role="status" className="text-body text-ink-soft">
                  Connecting…
                </p>
              )}
            </div>
          )}
        </main>
        {project && (
          <aside
            className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-4"
            aria-label="Source inspector"
          >
            <h2 className="text-body font-semibold">Source inspector</h2>
            {offline ? (
              <p role="status" className="text-body text-accent-ink">
                The Vite server is unavailable. Start it again and reconnect.
              </p>
            ) : target && picked ? (
              <SourceInspector
                key={`${picked.card}:${picked.marker}:${target.revision}`}
                marker={picked.marker}
                selected={target}
                onSave={save}
              />
            ) : (
              <p className="text-body text-ink-soft" role="status">
                {targetError ||
                  (picked
                    ? 'Reading source…'
                    : 'Select an element marked data-doop-edit. Play a card to interact with it and scroll without moving the canvas.')}
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

initTheme()

createRoot(document.getElementById('root')!).render(
  localSourceOrigin(location.origin) ? (
    <LocalCanvas />
  ) : (
    <main className="grid min-h-dvh place-items-center bg-paper p-4 text-body text-ink">
      Open Doop from a local HTTP address to use the source canvas.
    </main>
  ),
)
