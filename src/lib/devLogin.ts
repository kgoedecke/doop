import { authClient } from './auth'

/** Local testing uses a real session so API ownership and WebSockets still work. */
export const devLoginEnabled =
  import.meta.env.DEV &&
  import.meta.env.VITE_DEV_AUTO_LOGIN !== 'false' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

let pending: Promise<void> | undefined

export function devLogin(): Promise<void> {
  // Share one attempt across React StrictMode's effect replay.
  return (pending ??= signIn())
}

async function signIn(): Promise<void> {
  if (!devLoginEnabled) return
  const key = 'doop-local-test-account'
  const saved = localStorage.getItem(key)
  const credentials = saved
    ? (JSON.parse(saved) as { email: string; password: string })
    : { email: `local-${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() }
  localStorage.setItem(key, JSON.stringify(credentials))

  const response = await fetch('/api/account-exists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credentials.email }),
  })
  if (!response.ok) throw new Error('Could not check the local test account')
  const { exists } = await response.json()
  const result = exists
    ? await authClient.signIn.email(credentials)
    : await authClient.signUp.email({ ...credentials, name: 'Local Tester' })
  if (result.error) throw new Error(result.error.message || 'Local test login failed')
}
