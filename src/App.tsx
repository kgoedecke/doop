import { useEffect, useRef, useState } from 'react'
import { Home } from './pages/Home'
import { Settings } from './pages/Settings'
import { CanvasPage } from './pages/CanvasPage'
import { AuthPage } from './pages/AuthPage'
import { Admin } from './pages/Admin'
import { authClient } from './lib/auth'
import { setName } from './lib/identity'
import { posthog, syncReplayForUser, suspendAnalyticsWhileImpersonating } from './lib/posthog'
import { useMe } from './lib/me'
import { adminApi } from './lib/api'
import { Button } from './components/ui/button'
import { AuthScreen } from './components/ui/screen'
import { DesktopTabs, ShellDragBar } from './components/DesktopTabs'
import { isDesktopShell, setTabsUser } from './lib/desktop'

export function navigate(path: string) {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function App() {
  const [path, setPath] = useState(location.pathname)
  const { data: session, isPending } = authClient.useSession()
  const me = useMe(session?.user.id)
  const identifiedUserId = useRef<string | null>(null)

  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /* Reaching /admin mid "view as" — usually the Back button, since /admin
     stays in history when impersonation starts — can only mean "return to
     being the admin": the borrowed session has no admin access, so rendering
     the page would show its not-found screen. End the impersonation and
     arrive as the admin instead. */
  const returningToAdmin = !!me?.impersonating && path.startsWith('/admin')
  useEffect(() => {
    if (!returningToAdmin) return
    adminApi
      .stopImpersonating()
      .then(() => location.assign('/admin'))
      .catch(() => location.assign('/'))
  }, [returningToAdmin])

  /* The session is the auth boundary: this covers both successful login and
     restoring an existing session after a page refresh. */
  useEffect(() => {
    const user = session?.user
    if (!user) {
      if (identifiedUserId.current) {
        posthog.reset()
        identifiedUserId.current = null
      }
      return
    }
    /* Wait for /api/me before identifying anyone. Impersonation swaps the
       session cookie, so `user` here is the person being VIEWED — identifying
       them would write an admin's support session into that customer's
       profile and replay timeline. Only /api/me can tell the two apart. */
    if (!me) return
    if (me.impersonating) {
      suspendAnalyticsWhileImpersonating()
      identifiedUserId.current = null
      return
    }

    if (identifiedUserId.current === user.id) return
    if (identifiedUserId.current) posthog.reset()
    posthog.identify(user.id, { email: user.email, name: user.name })
    syncReplayForUser(user.email)
    identifiedUserId.current = user.id
  }, [session?.user, me])

  /* the account name is the identity shown on cursors and in the feed */
  useEffect(() => {
    if (session?.user?.name) setName(session.user.name)
  }, [session?.user?.name])

  /* the desktop tab strip is per-account state: restore this user's tabs,
     and clear the strip the moment the session goes away */
  useEffect(() => {
    if (!isPending) setTabsUser(session?.user?.id ?? null)
  }, [isPending, session?.user?.id])

  if (isPending)
    return (
      <>
        <ShellDragBar />
        <AuthScreen />
      </>
    )
  /* signed out: every path lands on the sign-in form. The marketing site is
     a separate service (see server/marketing.ts) that owns `/` for
     visitors; share links (/c/…) and interrupted MCP OAuth redirects keep
     their URL so the deep link / resume logic survives the sign-in. */
  if (!session)
    return (
      <>
        <ShellDragBar />
        <AuthPage />
      </>
    )

  /* /admin waits for /api/me: before it answers we can't tell an admin from
     a borrowed "view as" session, and rendering Admin in the latter flashes
     its not-found screen. Also blank while the effect above swaps the
     session back and reloads. */
  if (path.startsWith('/admin') && (!me || returningToAdmin)) return <div className="auth-page" />

  const canvasMatch = path.match(/^\/c\/([^/]+)/)
  const page = canvasMatch ? (
    <CanvasPage canvasId={canvasMatch[1]} key={canvasMatch[1]} />
  ) : path.startsWith('/admin') ? (
    <Admin />
  ) : path.startsWith('/settings') ? (
    <Settings />
  ) : (
    <Home />
  )

  /* The banner is not decoration: an impersonated session looks exactly like
     being signed in as that person, and forgetting you are in one is how
     support tools cause incidents. */
  return me?.impersonating ? (
    <>
      <ImpersonationBanner name={session.user.name} />
      {/* --app-inset is the contract with fixed-position screens: the canvas
          workspace is `fixed inset-0` and ignores this padding, so it offsets
          itself by the same variable instead of hardcoding the banner height */}
      <div className="h-dvh overflow-auto pt-14 [--app-inset:56px] sm:pt-10 sm:[--app-inset:40px]">{page}</div>
    </>
  ) : isDesktopShell() ? (
    /* the desktop shell's tab strip uses the same --app-inset contract as
       the banner: fixed screens (the canvas workspace) offset themselves */
    <>
      <DesktopTabs path={path} />
      <div className="h-dvh overflow-auto pt-10 [--app-inset:40px]">{page}</div>
    </>
  ) : (
    page
  )
}

function ImpersonationBanner({ name }: { name: string }) {
  const [leaving, setLeaving] = useState(false)
  return (
    <div className="fixed inset-x-0 top-0 z-[900] flex min-h-14 items-center justify-between gap-2 border-b border-accent-ink px-2.5 py-[7px] text-[11.5px] leading-tight text-accent-ink backdrop-blur-[6px] [background:repeating-linear-gradient(-45deg,rgba(208,52,31,0.16)_0_10px,rgba(208,52,31,0.08)_10px_20px)] sm:h-10 sm:min-h-0 sm:justify-center sm:gap-4 sm:text-[13px]">
      <span>
        Viewing as <strong>{name}</strong> — read only, expires after 15 minutes.
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          /* the cookie swaps back to the admin's own session; reload rather
             than reconcile every piece of per-user state in memory */
          adminApi
            .stopImpersonating()
            .then(() => location.assign('/admin'))
            .catch(() => location.assign('/'))
        }}
      >
        {leaving ? 'Leaving…' : 'Stop viewing'}
      </Button>
    </div>
  )
}
