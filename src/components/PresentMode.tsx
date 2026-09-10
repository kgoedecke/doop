import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { Button } from './ui/button'
import { XIcon } from './ui/icons'

/* Full-screen presentation of one frame: it fills the viewport (letterboxed
   on ink) at native resolution scaled to fit, still connected to the room so
   edits streaming in render live. Esc closes. */
export function PresentMode({ frameId, onClose }: { frameId: string; onClose: () => void }) {
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === frameId))
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:frame-ready') setReady(true)
      /* Escape with focus inside the frame (after clicking into it) never
         reaches this window as a key event; the runtime relays it */
      if (ev.data?.type === 'doop:esc') onClose()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onClose])

  const html = frame?.html ?? ''
  useEffect(() => {
    if (!ready) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html }, '*')
  }, [ready, html])

  useEffect(() => {
    function onResize() {
      setViewport({ w: window.innerWidth, h: window.innerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* capture phase so Esc closes the presentation without also reaching the
     canvas page, which would clear the selection underneath */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /* the frame vanished (deleted under us) — nothing left to present */
  useEffect(() => {
    if (!frame) onClose()
  }, [frame, onClose])

  const scale = useMemo(() => {
    if (!frame) return 1
    return Math.min(viewport.w / frame.width, viewport.h / frame.height)
  }, [frame, viewport])

  if (!frame) return null

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-ink"
      role="dialog"
      aria-label={`Presenting ${frame.name}`}
    >
      <div
        className="relative overflow-hidden bg-white"
        style={{ width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) }}
      >
        <iframe
          ref={iframeRef}
          className="block border-none bg-white"
          title={frame.name}
          sandbox="allow-scripts"
          srcDoc={FRAME_BOOTSTRAP}
          style={{ width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
        />
      </div>
      <Button
        variant="inverse"
        size="icon"
        className="absolute top-3 right-3 rounded-full opacity-60 hover:opacity-100"
        aria-label="Exit presentation"
        title="Exit presentation (Esc)"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  )
}
