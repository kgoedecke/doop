import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { Allowance } from '../lib/api'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { navigate } from '../App'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { cn } from '@/lib/utils'
import { ACCOUNT_KIND_LABELS } from '../../shared/modelMenu'
import { t as translate, useT, type Translate } from '../lib/i18n'

/**
 * Free-tier metering UI for the resident team: the shared allowance hook,
 * the "n free team tasks left" line, and the wall that appears when they're
 * gone. Server-enforced; this is only the mirror of /api/agent-allowance.
 */

export type { Allowance }

export function useAllowance(): { allowance: Allowance | null; refresh: () => void } {
  const [allowance, setAllowance] = useState<Allowance | null>(null)
  /* re-read whenever a model account is connected or dropped anywhere in the
     app, so every meter on screen agrees without prop-drilling */
  const version = useStore((s) => s.allowanceVersion)
  const refresh = useCallback(() => {
    api.agentAllowance().then(setAllowance, () => {})
  }, [])
  useEffect(refresh, [refresh, version])
  return { allowance, refresh }
}

/** True when this failure is the free tier running out (shows the wall). */
export function isResidentLimit(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.body.error === 'resident_limit'
}

/** Which of their own accounts the agent runs on, as one line. */
function byoText(allowance: Allowance, t: Translate): string {
  if (allowance.byoKind === 'gemini-cloud') return t('home.meterGeminiCloud')
  if (allowance.byoKind === 'claude-local') return t('home.meterClaudeLocal')
  if (allowance.byoKind === 'chatgpt' || !allowance.byoKind) return t('home.meterChatgpt')
  return t('home.meterProviderKey', { provider: ACCOUNT_KIND_LABELS[allowance.byoKind] })
}

/** The meter as one plain sentence, for a tooltip. A component passes its
 *  own `useT()` translator so the line follows a language switch. */
export function meterText(allowance: Allowance | null, t: Translate = translate): string | null {
  if (!allowance) return null
  if (allowance.byoModel) return byoText(allowance, t)
  if (allowance.limit <= 0) return t('home.meterNoFreeTier')
  const left = Math.max(0, allowance.limit - allowance.used)
  return left === 0 ? t('home.meterUsedUp') : t('home.meterLeft', { left, count: allowance.limit })
}

export function MeterLine({ allowance }: { allowance: Allowance | null }) {
  const t = useT()
  if (!allowance) return null
  /* their own account is behind the agent now — say so instead of counting,
     and say it even where there is no free tier to count (limit 0) */
  if (allowance.byoModel) {
    return <span className="text-[12px] text-success-ink">{byoText(allowance, t)}</span>
  }
  /* no free tier on this server: say what connecting gets them instead of
     counting tasks that don't exist */
  if (allowance.limit <= 0) {
    return <span className="text-[12px] text-ink-faint">{t('home.meterNoFreeTier')}</span>
  }
  const left = Math.max(0, allowance.limit - allowance.used)
  return (
    <span className={cn('text-[12px]', left === 0 ? 'text-accent-ink' : 'text-ink-faint')}>
      {left === 0 ? t('home.meterUsedUpLine') : t('home.meterLeft', { left, count: allowance.limit })}
    </span>
  )
}

export function LimitWall({
  canvasId,
  onClose,
  onOpenConnect,
}: {
  canvasId: string
  onClose: () => void
  onOpenConnect: () => void
}) {
  const { allowance } = useAllowance()
  const t = useT()
  /* "used up" only fits a server that granted free tasks in the first place;
     everywhere else (the default, limit 0) this wall IS the getting-started
     step — while the allowance loads, assume the no-free-tier common case */
  const hadFreeTier = allowance != null && allowance.limit > 0
  useEffect(() => {
    posthog.capture('resident_limit_hit')
  }, [])
  return (
    <Modal size="lg" onClose={onClose}>
      <>
        <ModalTitle>{hadFreeTier ? t('home.wallUsedUpTitle') : t('home.wallConnectTitle')}</ModalTitle>
        <ModalLede>
          {hadFreeTier ? (
            <>
              {t('home.wallUsedUpBefore')} <b>{t('home.wallUsedUpBold')}</b> {t('home.wallUsedUpAfter')}
            </>
          ) : (
            <>
              {t('home.wallConnectBefore')} <b>ChatGPT</b> {t('home.wallConnectAfter')}
            </>
          )}
        </ModalLede>
        {/* the connection itself is an account setting, so this hands off to
            Settings rather than carrying a second copy of the panel */}
        <ModalActions className="justify-start">
          <Button
            variant="primary"
            onClick={() => {
              posthog.capture('resident_limit_connect_clicked')
              /* carry the canvas so Settings can send them straight back */
              navigate(`/settings?from=${encodeURIComponent(`/c/${canvasId}`)}`)
            }}
          >
            {t('home.wallConnectButton')}
          </Button>
        </ModalActions>

        {/* the MCP path is a different mode — an agent you prompt yourself, not
            one that picks up queued tasks — so it hands off instead of inlining
            the setup steps here where they read like a fix for the queued card */}
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[12.5px] text-ink-faint">
            {t('home.wallMcp')}{' '}
            <button
              type="button"
              className="font-semibold text-ink underline underline-offset-2"
              onClick={onOpenConnect}
            >
              {t('home.wallMcpLink')}
            </button>
          </p>
        </div>

        <ModalActions>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </ModalActions>
      </>
    </Modal>
  )
}
