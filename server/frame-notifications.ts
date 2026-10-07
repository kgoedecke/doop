import pg from 'pg'

type Listener = (canvasId?: string) => void
const listeners = new Set<Listener>()

export function membershipChanged(canvasId?: string) {
  for (const listener of listeners) listener(canvasId)
}

export function subscribeMembershipChanges(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** One dedicated LISTEN connection per app server; SQL snapshots repair missed notifications. */
export async function startFrameNotifications(): Promise<() => Promise<void>> {
  if (!process.env.DATABASE_URL) return async () => {}
  let stopped = false
  let client: pg.Client | undefined
  let retry: ReturnType<typeof setTimeout> | undefined

  async function connect() {
    if (stopped) return
    const current = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      application_name: 'doop-frame-membership',
      connectionTimeoutMillis: 5000,
    })
    client = current
    let lost = false
    const reconnect = () => {
      if (lost || stopped) return
      lost = true
      void current.end().catch(() => {})
      retry = setTimeout(() => void connect(), 1000)
    }
    current.on('error', reconnect)
    current.on('end', reconnect)
    current.on('notification', ({ channel, payload }) => {
      if (channel === 'doop_frame_membership' && payload) membershipChanged(payload)
    })
    try {
      await current.connect()
      await current.query('LISTEN doop_frame_membership')
      // Subscribe first, then refresh every open canvas, including after reconnect.
      if (!stopped) membershipChanged()
    } catch (error) {
      console.error('[frame notifications]', error)
      reconnect()
    }
  }

  await connect()
  return async () => {
    stopped = true
    clearTimeout(retry)
    await client?.end().catch(() => {})
  }
}
