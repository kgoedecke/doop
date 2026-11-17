import { useEffect, useState } from 'react'
import { FREE_FONT_FAMILIES, FREE_UPLOAD_BYTES, PRIORITY_SUPPORT, PRO_UPLOAD_BYTES } from '../../shared/billing'
import type { WorkspaceSummary } from '../../shared/types'
import { api } from '../lib/api'
import { authClient } from '../lib/auth'
import { useT } from '../lib/i18n'
import { useMe } from '../lib/me'
import { navigate } from '../lib/navigate'
import { formatMegabytes } from '../lib/planFeatures'
import { openUpgrade } from '../lib/upgrade'
import { PlanComparisonTable } from './PlanCards'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { RocketIcon } from './ui/icons'
import { Skeleton } from './ui/skeleton'

/** Settings → Plan: the plan the account is on, the way to Pro (or to its
 *  billing), priority support for Pro, and every plan side by side. */
export function PlanSettings() {
  const t = useT()
  const { data: session } = authClient.useSession()
  const me = useMe(session?.user.id)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)

  useEffect(() => {
    let live = true
    api.listWorkspaces().then((r) => live && setWorkspaces(r.workspaces), console.error)
    return () => {
      live = false
    }
  }, [])

  if (!me) return <Skeleton shape="card" className="mt-6 max-w-[1000px]" />

  const pro = me.plan === 'team'
  /* billing off, the server limits nothing: show what is actually allowed */
  const unlimited = pro || !me.billing
  const through = workspaces?.find((w) => w.active && w.plan === 'team')

  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('plans.currentPlan')}</CardTitle>
          {!me.billing && <CardDescription>{t('plans.billingIncluded')}</CardDescription>}
        </CardHeader>
        <CardRow
          label={
            <span className="flex items-center gap-2">
              {unlimited ? <Badge tone="accent">pro</Badge> : <Badge>free</Badge>}
              {!me.billing ? t('plans.selfHostedName') : pro ? t('plans.proName') : t('plans.freeName')}
            </span>
          }
          action={
            !me.billing ? null : pro ? (
              through &&
              through.role !== 'member' && (
                <Button size="sm" onClick={() => navigate(`/w/${through.id}?pane=billing`)}>
                  {t('plans.manageBilling')}
                </Button>
              )
            ) : (
              <Button size="sm" variant="primary" onClick={() => openUpgrade({ source: 'settings' })}>
                <RocketIcon size="rail" /> {t('plans.upgradeToPro')}
              </Button>
            )
          }
        >
          <p className="text-body text-ink-soft">
            {!me.billing
              ? t('plans.selfHostedSummary', { size: formatMegabytes(PRO_UPLOAD_BYTES) })
              : pro
                ? t('plans.proSummary', {
                    name: through?.name ?? '…',
                    size: formatMegabytes(PRO_UPLOAD_BYTES),
                  })
                : t('plans.freeSummary', {
                    size: formatMegabytes(FREE_UPLOAD_BYTES),
                    fonts: t('plans.fontFamilies', { count: FREE_FONT_FAMILIES }),
                  })}
          </p>
        </CardRow>
      </SettingsCard>

      {pro && me.billing && (
        <SettingsCard>
          <CardHeader>
            <CardTitle>{t('plans.prioritySupport')}</CardTitle>
            <CardDescription>{t('plans.supportLine')}</CardDescription>
          </CardHeader>
          <CardRow
            action={
              <Button size="sm" asChild>
                <a href={PRIORITY_SUPPORT}>{t('plans.emailSupport')}</a>
              </Button>
            }
          />
        </SettingsCard>
      )}

      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('plans.comparePlans')}</CardTitle>
        </CardHeader>
        <PlanComparisonTable className="px-4 pb-4 sm:px-[22px]" />
      </SettingsCard>
    </>
  )
}
