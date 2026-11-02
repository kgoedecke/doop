import { useEffect, useState } from 'react'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { useT, type PlainMessageKey } from '../lib/i18n'

/** A failure we describe ourselves (`key`), or one the browser described (`text`). */
type Failure = { key: PlainMessageKey } | { text: string }

/** Thrown for a failure whose words are ours, so the message is picked in the
 *  active language when it is shown rather than when it happens. */
class ConsentError extends Error {
  constructor(readonly key: PlainMessageKey) {
    super(key)
  }
}

function failureOf(err: unknown, fallback: PlainMessageKey): Failure {
  if (err instanceof ConsentError) return { key: err.key }
  if (err instanceof Error) return { text: err.message }
  return { key: fallback }
}

export function OAuthConsent({ email }: { email: string }) {
  const t = useT()
  const code = new URLSearchParams(location.search).get('consent_code') ?? ''
  const [client, setClient] = useState<{ name: string } | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const endpoint = `/api/mcp-consent/${encodeURIComponent(code)}`

  useEffect(() => {
    const controller = new AbortController()
    fetch(endpoint, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new ConsentError('auth.consentExpired')
        return res.json() as Promise<{ name: string }>
      })
      .then(setClient)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(failureOf(err, 'auth.consentLoadFailed'))
      })
    return () => controller.abort()
  }, [endpoint])

  async function respond(accept: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept }),
      })
      if (!res.ok) throw new ConsentError('auth.consentFinishFailedRetry')
      const result = (await res.json()) as { redirectURI: string }
      location.assign(result.redirectURI)
    } catch (err) {
      setError(failureOf(err, 'auth.consentFinishFailed'))
      setBusy(false)
    }
  }

  return (
    <AuthScreen>
      <AuthCard title={client ? t('auth.consentTitle', { name: client.name }) : t('auth.consentTitleGeneric')}>
        <AuthCardText className="break-all">{t('auth.consentSignedInAs', { email })}</AuthCardText>
        <AuthCardText>{t('auth.consentScope')}</AuthCardText>
        {error && <Callout tone="error">{'key' in error ? t(error.key) : error.text}</Callout>}
        <div className="flex justify-end gap-2">
          <Button disabled={!client || busy} onClick={() => void respond(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="solid" disabled={!client || busy} onClick={() => void respond(true)}>
            {busy ? t('auth.connecting') : t('auth.connect')}
          </Button>
        </div>
      </AuthCard>
    </AuthScreen>
  )
}
