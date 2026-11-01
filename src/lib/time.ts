import { t } from './i18n'

/* Called while a component renders; that component's useT() is what
   re-renders it on a language switch, so the free t reads the same language. */
export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 5) return t('common.justNow')
  if (s < 60) return t('common.secondsAgo', { count: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('common.minutesAgo', { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('common.hoursAgo', { count: h })
  return t('common.daysAgo', { count: Math.floor(h / 24) })
}
