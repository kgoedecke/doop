import { useEffect, useState } from 'react'

/** /api/me — the session as the server sees it. */
export interface Me {
  id: string
  name: string
  email: string
  /** instance admin: renders the /admin entry point */
  admin: boolean
  /** 'team' while a member of a live paid workspace; the account menu's plan line */
  plan: 'free' | 'team'
  /** set when this session is an admin viewing as someone else. The rest of
   *  this object then describes the person being viewed, not the admin —
   *  impersonation replaces the session cookie outright — so this flag is the
   *  only way the app can tell it is in a borrowed session. */
  impersonating?: { byName: string }
}

/* Keyed by the signed-in user id, and never caching a failure. Both matter:
   the app mounts on the signed-out auth page, where /api/me is a 401, and
   signing in does not remount it — a cached rejection would leave every
   later caller with no `me` for the rest of the session. The key also makes
   entering and leaving a "view as" session refetch, since impersonation
   changes who the session belongs to. */
let cache: { key: string; promise: Promise<Me> } | null = null

export function loadMe(key: string): Promise<Me> {
  if (cache?.key !== key) {
    const promise = fetch('/api/me').then((r) => {
      if (!r.ok) throw new Error(`me ${r.status}`)
      return r.json() as Promise<Me>
    })
    promise.catch(() => {
      if (cache?.promise === promise) cache = null // retry on the next call
    })
    cache = { key, promise }
  }
  return cache.promise
}

/** Pass the session's user id; null until /api/me answers for that identity. */
export function useMe(userId: string | undefined): Me | null {
  const [me, setMe] = useState<Me | null>(null)
  useEffect(() => {
    if (!userId) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    /* loadMe forgets failures so "the next call" retries — but with a stable
       userId this effect never runs again, so a transient /api/me failure
       would otherwise leave `me` null for the whole session (and blank any
       screen gated on it). Keep calling until it answers. */
    const attempt = () => {
      loadMe(userId)
        .then((m) => live && setMe(m))
        .catch(() => {
          if (live) timer = setTimeout(attempt, 3000)
        })
    }
    attempt()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [userId])
  /* never hand back a `me` belonging to a previous identity */
  return me && me.id === userId ? me : null
}
