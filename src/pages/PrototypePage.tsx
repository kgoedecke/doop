import { useEffect, useState } from 'react'
import { canvasPages } from '../../shared/pages'
import { flowStartFrame } from '../../shared/prototype'
import { connect, disconnect } from '../lib/ws'
import { useStore } from '../lib/store'
import { navigate } from '../lib/navigate'
import { PrototypePlayer } from '../components/PrototypePlayer'
import { Button } from '../components/ui/button'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { useT } from '@/lib/i18n'

/**
 * /c/<canvasId>/proto[?frame=<id>|?page=<id>] — the prototype player as a
 * page of its own, the link to hand to someone who should click through the
 * flow. It joins the canvas room like the editor (the server's canvas access
 * gate decides who gets in, and frames stay live) but draws no editor chrome.
 * Without a frame it opens on the page's flow start.
 */
export function PrototypePage({ canvasId }: { canvasId: string }) {
  const canvas = useStore((s) => s.canvas)
  const notFound = useStore((s) => s.canvasNotFound)
  /* read once: later navigations rewrite ?frame= as the flow moves on */
  const [query] = useState(() => new URLSearchParams(location.search))
  const t = useT()

  useEffect(() => {
    connect(canvasId)
    return () => {
      disconnect()
      useStore.getState().setCanvas(null)
      useStore.getState().setCanvasNotFound(false)
    }
  }, [canvasId])

  if (notFound)
    return (
      <AuthScreen>
        <AuthCard title={t('panels.protoNotFound')} align="center">
          <AuthCardText>{t('panels.protoNotFoundText')}</AuthCardText>
          <Button className="self-center" onClick={() => navigate('/')}>
            {t('panels.protoBackToCanvases')}
          </Button>
        </AuthCard>
      </AuthScreen>
    )
  if (canvas?.id !== canvasId) return <div className="fixed inset-0 bg-code" aria-busy />

  const requested = query.get('frame')
  const pageId = query.get('page') ?? canvasPages(canvas)[0]!.id
  const start = canvas.frames.find((f) => f.id === requested) ?? flowStartFrame(canvas, pageId)
  if (!start)
    return (
      <AuthScreen>
        <AuthCard title={t('panels.protoNothing')} align="center">
          <AuthCardText>{t('panels.protoNothingText')}</AuthCardText>
          <Button className="self-center" onClick={() => navigate(`/c/${canvasId}`)}>
            {t('panels.protoOpenCanvas')}
          </Button>
        </AuthCard>
      </AuthScreen>
    )
  return <PrototypePlayer startFrameId={start.id} syncUrl />
}
