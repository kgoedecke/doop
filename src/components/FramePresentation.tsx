import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { useStore } from '../lib/store'
import { Button } from './ui/button'
import { Modal, ModalTitle } from './ui/modal'

export function FramePresentation() {
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === s.presentedFrameId))
  return frame ? (
    <Modal
      size="fullscreen"
      onClose={() => useStore.getState().presentFrame(null)}
      aria-describedby={undefined}
      onKeyDown={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <Presentation key={frame.id} frame={frame} />
    </Modal>
  ) : null
}

function Presentation({ frame }: { frame: Frame }) {
  const presentFrame = useStore((s) => s.presentFrame)
  const surface = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const iframe = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [scale, setScale] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const close = () => presentFrame(null)

  /* Measure the available stage, including when browser fullscreen or device
     rotation changes it. The iframe keeps its design viewport at every size. */
  useLayoutEffect(() => {
    const el = stage.current!
    const observer = new ResizeObserver(([entry]) => {
      setScale(Math.min(entry.contentRect.width / frame.width, entry.contentRect.height / frame.height))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [frame.width, frame.height])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframe.current?.contentWindow) return
      if (event.data?.type === 'doop:frame-ready') setReady(true)
      /* Keyboard events in a sandboxed iframe do not bubble to the dialog. */
      if (event.data?.type === 'doop:frame-esc') presentFrame(null)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [presentFrame])

  useEffect(() => {
    if (ready) iframe.current?.contentWindow?.postMessage({ type: 'doop:html', html: frame.html }, '*')
  }, [ready, frame.html])

  useEffect(() => {
    const el = surface.current!
    let entered = false
    function onFullscreenChange() {
      const active = document.fullscreenElement === el
      setFullscreen(active)
      /* The browser consumes Escape in native fullscreen. Its exit event
         must close the presentation too, so one Escape always returns. */
      if (entered && !active) presentFrame(null)
      entered = active
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {})
    }
  }, [presentFrame])

  return (
    <div ref={surface} className="flex h-full w-full flex-col bg-ink text-white">
      <div className="flex shrink-0 items-center gap-3 px-4 py-3">
        <ModalTitle className="min-w-0 flex-1 truncate font-sans text-sm sm:text-sm">{frame.name}</ModalTitle>
        {document.fullscreenEnabled && !fullscreen && (
          <Button
            variant="inverse"
            size="sm"
            onClick={() => {
              /* Embedded browsers may deny native fullscreen; the window-
                   filling presentation remains usable without permission. */
              void surface.current?.requestFullscreen().catch(() => {})
            }}
          >
            Fullscreen
          </Button>
        )}
        <Button variant="inverse" size="sm" onClick={close} aria-label="Close presentation">
          <span aria-hidden="true">✕</span> Close <span className="font-mono text-xs opacity-60">Esc</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 px-4 pb-4">
        <div ref={stage} className="flex h-full w-full items-center justify-center overflow-hidden">
          <div className="relative shrink-0" style={{ width: frame.width * scale, height: frame.height * scale }}>
            <iframe
              ref={iframe}
              title={`Presentation: ${frame.name}`}
              sandbox="allow-scripts"
              srcDoc={FRAME_BOOTSTRAP}
              className="absolute left-0 top-0 origin-top-left border-0 bg-white"
              style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
