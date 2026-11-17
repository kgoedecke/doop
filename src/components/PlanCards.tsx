import {
  ENTERPRISE_CONTACT,
  formatUsd,
  seatPerMonth,
  type BillingInterval,
  type Plan,
  type PlanId,
} from '../../shared/billing'
import { COMPARISON, HIGHLIGHTS, formatMegabytes, type Cell, type Highlight } from '../lib/planFeatures'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Disclosure } from './ui/collapsible'
import { ArrowRightIcon, CheckIcon, MinusIcon } from './ui/icons'

/**
 * The plans as the upgrade modal and Settings → Plan show them: one card per
 * plan with a short list, and the full table folded under "Compare all
 * features". What each plan offers is in lib/planFeatures.
 */

const PLAN_NAME: Record<PlanId, PlainMessageKey> = {
  free: 'plans.freeName',
  team: 'plans.proName',
  enterprise: 'plans.enterpriseName',
}

const PLAN_TAGLINE: Record<PlanId, PlainMessageKey> = {
  free: 'plans.freeTagline',
  team: 'plans.proTagline',
  enterprise: 'plans.enterpriseTagline',
}

const PLAN_IDS: readonly PlanId[] = ['free', 'team', 'enterprise']

export function PlanCard({ plan, interval, current }: { plan: Plan; interval: BillingInterval; current: boolean }) {
  const pro = plan.id === 'team'
  const price = plan.seatPrice ? plan.seatPrice[interval] : null
  const t = useT()
  return (
    <div
      className={cn(
        'flex flex-col rounded-card border px-4 py-4',
        pro ? 'border-brand bg-surface shadow-pop' : 'border-line bg-surface',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-lead font-medium">{t(PLAN_NAME[plan.id])}</span>
        {pro && !current && <Badge tone="brand">{t('home.popular')}</Badge>}
        {current && <span className="text-caption text-ink-faint">{t('home.current')}</span>}
      </div>
      <p className="mt-1 text-body text-ink-soft">{t(PLAN_TAGLINE[plan.id])}</p>
      <div className="mt-3 text-title font-medium text-ink">
        {price === null ? (
          plan.id === 'free' ? (
            '$0'
          ) : (
            <span className="text-heading">{t('home.letsTalk')}</span>
          )
        ) : (
          <>
            {formatUsd(interval === 'year' ? seatPerMonth('year') : price)}
            <span className="ml-1 font-sans text-label font-medium text-ink-faint">{t('home.perSeatMonth')}</span>
          </>
        )}
      </div>
      {price !== null && interval === 'year' && (
        <span className="text-caption text-ink-faint">{t('home.billedYearly', { price: formatUsd(price) })}</span>
      )}
      {pro && <p className="mt-3.5 text-caption text-ink-faint">{t('plans.everythingInFree')}</p>}
      <ul className={cn('flex flex-col gap-[7px] text-body text-ink-soft', pro ? 'mt-2' : 'mt-3.5')}>
        {HIGHLIGHTS[plan.id].map((line, i) => (
          <li key={i} className="flex gap-2">
            <CheckIcon className="mt-[2px] size-3.5 flex-none text-accent-ink" />
            <HighlightText line={line} />
          </li>
        ))}
      </ul>
      {plan.id === 'enterprise' && (
        <a
          className="mt-auto flex items-center gap-1 pt-4 text-body font-medium text-ink underline underline-offset-2"
          href={ENTERPRISE_CONTACT}
          target="_blank"
          rel="noreferrer"
        >
          {t('home.contactUs')}
          <ArrowRightIcon size={14} />
        </a>
      )}
    </div>
  )
}

function HighlightText({ line }: { line: Highlight }) {
  const t = useT()
  if ('uploads' in line) return <span>{t('plans.proUploads', { size: formatMegabytes(line.uploads) })}</span>
  return (
    <span>
      {t(line.key)}
      {line.soon && (
        <Badge tone="outline" className="ml-1.5 align-[1px]">
          {t('plans.soon')}
        </Badge>
      )}
    </span>
  )
}

/** Every feature, plan by plan, folded away until asked for. */
export function PlanComparison({ className }: { className?: string }) {
  const t = useT()
  return (
    <Disclosure
      className={className}
      label={t('plans.compareAll')}
      triggerClassName="text-body font-medium text-ink-soft"
    >
      <PlanComparisonTable />
    </Disclosure>
  )
}

/** The comparison itself, as Settings → Plan shows it, unfolded. */
export function PlanComparisonTable({ className }: { className?: string }) {
  const t = useT()
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full min-w-[480px] border-collapse text-body">
        <thead>
          <tr className="text-left text-caption text-ink-faint">
            <th scope="col" className="py-2 pr-3 font-normal">
              <span className="sr-only">{t('plans.feature')}</span>
            </th>
            {PLAN_IDS.map((id) => (
              <th key={id} scope="col" className="w-[22%] px-2 py-2 text-center font-medium text-ink">
                {t(PLAN_NAME[id])}
              </th>
            ))}
          </tr>
        </thead>
        {COMPARISON.map((group) => (
          <tbody key={group.label}>
            <tr>
              <th
                scope="colgroup"
                colSpan={4}
                className="pb-1.5 pt-4 text-left text-caption font-medium text-ink-faint"
              >
                {t(group.label)}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.label} className="border-t border-line-soft">
                <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-soft">
                  {t(row.label)}
                </th>
                {PLAN_IDS.map((id) => (
                  <td key={id} className="px-2 py-2 text-center text-ink">
                    <CellValue cell={row.cells[id]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

function CellValue({ cell }: { cell: Cell }) {
  const t = useT()
  if (cell === true) return <CheckIcon aria-label={t('plans.included')} className="mx-auto size-3.5 text-accent-ink" />
  if (cell === false)
    return <MinusIcon aria-label={t('plans.notIncluded')} className="mx-auto size-3.5 text-ink-ghost" />
  if (cell === 'soon') return <Badge tone="outline">{t('plans.soon')}</Badge>
  if (cell === 'unlimited') return <>{t('plans.unlimited')}</>
  if ('bytes' in cell) return <>{formatMegabytes(cell.bytes)}</>
  return <>{t('plans.fontFamilies', { count: cell.families })}</>
}
