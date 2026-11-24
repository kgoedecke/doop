import { useMemo, useState } from 'react'
import { editorRedirect, parseEditorConnectQuery } from '../../shared/editorConnect'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { useT } from '../lib/i18n'

type Phase = { kind: 'ask' } | { kind: 'sending' } | { kind: 'sent'; link: string } | { kind: 'failed'; error: string }

/* Step 2 of connecting a code editor (shared/editorConnect.ts): the person,
   signed in, confirms the editor that sent them here. The server mints an
   agent key for it and an exchange code, and the browser follows the editor's
   deep link with the code. Asking first matters: the link that opened this
   page could have come from anywhere, and the key acts as this account. */
export function EditorConnect({ email }: { email: string }) {
  const t = useT()
  const request = useMemo(() => parseEditorConnectQuery(location.search), [])
  const editor = request ? (editorRedirect(request.redirect)?.editor ?? '') : ''
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' })

  const connect = async () => {
    if (!request) return
    setPhase({ kind: 'sending' })
    try {
      const res = await fetch('/api/editor/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !body.url) {
        setPhase({ kind: 'failed', error: body.error ?? t('auth.editorConnectFailed') })
        return
      }
      setPhase({ kind: 'sent', link: body.url })
      location.assign(body.url)
    } catch {
      setPhase({ kind: 'failed', error: t('auth.editorConnectFailed') })
    }
  }

  if (!request)
    return (
      <AuthScreen>
        <AuthCard title={t('auth.somethingWentWrongTitle')}>
          <Callout tone="error">{t('auth.editorConnectBadLink')}</Callout>
        </AuthCard>
      </AuthScreen>
    )

  return (
    <AuthScreen>
      <AuthCard
        title={phase.kind === 'sent' ? t('auth.editorConnectSentTitle') : t('auth.editorConnectTitle', { editor })}
      >
        {phase.kind === 'sent' ? (
          <>
            <AuthCardText>{t('auth.editorConnectSentBody', { editor })}</AuthCardText>
            <Button asChild className="mt-1">
              <a href={phase.link}>{t('auth.editorConnectOpen', { editor })}</a>
            </Button>
          </>
        ) : (
          <>
            <AuthCardText>{t('auth.editorConnectBody', { editor, email })}</AuthCardText>
            {phase.kind === 'failed' && <Callout tone="error">{phase.error}</Callout>}
            <Button
              variant="primary"
              className="mt-1"
              disabled={phase.kind === 'sending'}
              onClick={() => void connect()}
            >
              {phase.kind === 'sending' ? t('auth.connecting') : t('auth.editorConnectAllow', { editor })}
            </Button>
          </>
        )}
      </AuthCard>
    </AuthScreen>
  )
}
