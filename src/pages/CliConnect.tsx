import { useMemo, useState } from 'react'
import { parseCliConnectQuery } from '../../shared/cliConnect'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { CodeBlock } from '../components/ui/code-block'
import { useT } from '../lib/i18n'

type Phase =
  | { kind: 'ask' }
  | { kind: 'sending' }
  /** the browser is on its way to the CLI's own address on this machine */
  | { kind: 'sent'; link: string }
  /** the CLI is not listening: the person carries the code to the terminal */
  | { kind: 'code'; code: string }
  | { kind: 'failed'; error: string }

/* Step 2 of signing the doop CLI in (shared/cliConnect.ts): the person, signed in, confirms
   the CLI that sent them here. The server mints an exchange code, which the browser hands to
   the CLI on this machine or, where the CLI could not listen, shows for pasting. Asking first
   matters: the link that opened this page could have come from anywhere, and the key the
   code is traded for acts as this account. */
export function CliConnect({ email }: { email: string }) {
  const t = useT()
  const request = useMemo(() => parseCliConnectQuery(location.search), [])
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' })

  const connect = async () => {
    if (!request) return
    setPhase({ kind: 'sending' })
    try {
      const res = await fetch('/api/cli/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const body = (await res.json().catch(() => ({}))) as { url?: string; code?: string; error?: string }
      if (res.ok && body.url) {
        setPhase({ kind: 'sent', link: body.url })
        location.assign(body.url)
      } else if (res.ok && body.code) setPhase({ kind: 'code', code: body.code })
      else setPhase({ kind: 'failed', error: body.error ?? t('auth.cliConnectFailed') })
    } catch {
      setPhase({ kind: 'failed', error: t('auth.cliConnectFailed') })
    }
  }

  if (!request)
    return (
      <AuthScreen>
        <AuthCard title={t('auth.somethingWentWrongTitle')}>
          <Callout tone="error">{t('auth.cliConnectBadLink')}</Callout>
        </AuthCard>
      </AuthScreen>
    )

  if (phase.kind === 'sent')
    return (
      <AuthScreen>
        <AuthCard title={t('auth.cliConnectSentTitle')}>
          <AuthCardText>{t('auth.cliConnectSentBody')}</AuthCardText>
          <Button asChild className="mt-1">
            <a href={phase.link}>{t('auth.cliConnectOpen')}</a>
          </Button>
        </AuthCard>
      </AuthScreen>
    )

  if (phase.kind === 'code')
    return (
      <AuthScreen>
        <AuthCard title={t('auth.cliConnectCodeTitle')}>
          <AuthCardText>{t('auth.cliConnectCodeBody')}</AuthCardText>
          <CodeBlock text={phase.code} />
        </AuthCard>
      </AuthScreen>
    )

  return (
    <AuthScreen>
      <AuthCard title={t('auth.cliConnectTitle')}>
        <AuthCardText>{t('auth.cliConnectBody', { name: request.name, email })}</AuthCardText>
        {phase.kind === 'failed' && <Callout tone="error">{phase.error}</Callout>}
        <Button variant="primary" className="mt-1" disabled={phase.kind === 'sending'} onClick={() => void connect()}>
          {phase.kind === 'sending' ? t('auth.connecting') : t('auth.cliConnectAllow')}
        </Button>
      </AuthCard>
    </AuthScreen>
  )
}
