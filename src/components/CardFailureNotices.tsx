import { useEffect, useRef, useState } from 'react'
import { authClient } from '../lib/auth'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'

/**
 * Says so when a board card this person queued fails while the canvas is open
 * (a repo import's cards fail on their own, long after the import window
 * closed), naming the card and why. Cards that had failed before the canvas
 * opened are not announced. Renders nothing.
 */
export function CardFailureNotices() {
  const t = useT()
  const userId = authClient.useSession().data?.user.id
  const tasks = useStore((s) => s.tasks)
  /* the tasks arrive after the canvas opens, old failures among them: only
     a failure stamped after opening (server clock, a little slack) is news */
  const [openedAt] = useState(() => Date.now() - 2000)
  const seen = useRef(new Set<string>())
  useEffect(() => {
    const fresh = tasks.filter(
      (task) => task.queuedBy && task.failedAt && task.failedAt >= openedAt && !seen.current.has(task.id),
    )
    for (const task of fresh) seen.current.add(task.id)
    const mine = fresh.filter((task) => userId && task.queuedByUserId === userId)
    if (!mine.length) return
    const first = mine[0]!
    useStore
      .getState()
      .pushNotice(
        mine.length === 1
          ? t('canvas.cardFailed', { card: first.status, reason: first.failureReason ?? '' })
          : t('canvas.cardsFailed', { count: mine.length, reason: first.failureReason ?? '' }),
      )
  }, [tasks, userId, t, openedAt])
  return null
}
