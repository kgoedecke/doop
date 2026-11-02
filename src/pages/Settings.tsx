import { useState } from 'react'
import { navigate } from '../App'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { ModelAccountPanel } from '../components/ModelAccount'
import { ImageModelCard } from '../components/ImageModelCard'
import { useAllowance } from '../components/TeamAllowance'
import { ACCOUNT_KIND_LABELS } from '../../shared/modelMenu'
import { AccountSettings } from '../components/AccountSettings'
import { AppearanceSettings } from '../components/AppearanceSettings'
import { AgentKeys } from '../components/AgentKeys'
import { Webhooks } from '../components/Webhooks'
import { AccountMenu } from '../components/DashShell'
import { railLayout } from '../components/AppRail'
import { BellIcon, ChevronLeftIcon, KeyIcon, MoonIcon, SparkIcon, UserIcon } from '../components/ui/icons'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { CardDescription, CardHeader, CardTitle, SettingsCard } from '../components/ui/card'
import { Progress } from '../components/ui/progress'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSidebar,
  DashSidebarBrand,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'

type Pane = 'agent' | 'keys' | 'webhooks' | 'account' | 'appearance'

/* the heading over each pane, and the line under it */
const panes: Record<Pane, { title: PlainMessageKey; blurb: PlainMessageKey }> = {
  agent: { title: 'settings.agentTitle', blurb: 'settings.agentBlurb' },
  keys: { title: 'settings.keysTitle', blurb: 'settings.keysBlurb' },
  webhooks: { title: 'settings.webhooksTitle', blurb: 'settings.webhooksBlurb' },
  account: { title: 'settings.accountTitle', blurb: 'settings.accountBlurb' },
  appearance: { title: 'settings.appearanceTitle', blurb: 'settings.appearanceBlurb' },
}

function isPane(value: string | null): value is Pane {
  return value !== null && value in panes
}

/** ?pane= deep-links a section — the connect modal sends people to ?pane=keys. */
function initialPane(): Pane {
  const pane = new URLSearchParams(location.search).get('pane')
  return isPane(pane) ? pane : 'agent'
}

/**
 * Account settings. Today it holds one thing — which model account the Doop
 * Agent runs on once the free tasks are spent — but it is the account-level
 * home for that kind of setting, so the canvas surfaces can link here instead
 * of carrying their own copy of it.
 *
 * It wears the same shell as the home dashboard: same rail, same top bar, same
 * account menu. Only the rail's middle changes, to a settings sub-nav.
 */
export function Settings() {
  /* the sub-nav switches panes rather than scrolling to an anchor — on a page
     this short an anchor jump looks like nothing happened */
  const [pane, setPane] = useState<Pane>(initialPane)
  const t = useT()
  const { allowance, refresh } = useAllowance()
  const left = allowance ? Math.max(0, allowance.limit - allowance.used) : null
  /* arriving from a canvas (the free-tier wall) should not cost you your
     place — only same-origin canvas paths are honoured */
  const from = new URLSearchParams(location.search).get('from')
  const back = from && /^\/c\/[A-Za-z0-9_-]+$/.test(from) ? from : '/'

  const meter = allowance
    ? allowance.byoModel
      ? allowance.byoKind === 'gemini-cloud'
        ? t('settings.meterGeminiCloud')
        : allowance.byoKind === 'claude-local'
          ? t('settings.meterClaudeLocal')
          : allowance.byoKind === 'chatgpt' || !allowance.byoKind
            ? t('settings.meterChatgpt')
            : t('settings.meterProviderKey', { provider: ACCOUNT_KIND_LABELS[allowance.byoKind] })
      : allowance.limit <= 0
        ? t('settings.meterNoFreeTasks')
        : left === 0
          ? t('settings.meterUsedUp')
          : t('settings.meterLeft', { left: left ?? 0, count: allowance.limit })
    : null

  return (
    <DashLayout className={railLayout}>
      {/* Settings is its own screen: a rail of its panes, and the way back */}
      <DashSidebar variant="rail">
        <DashSidebarBrand />
        <nav className="flex flex-col gap-0.5">
          <DashNavItem density="rail" icon={<ChevronLeftIcon size="rail" />} onClick={() => navigate(back)}>
            {back === '/' ? t('settings.backToCanvases') : t('settings.backToCanvas')}
          </DashNavItem>
        </nav>
        <DashSectionLabel density="rail">{t('settings.sectionLabel')}</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem
            density="rail"
            icon={<SparkIcon size="rail" />}
            active={pane === 'agent'}
            onClick={() => setPane('agent')}
          >
            {t('settings.agentTitle')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<KeyIcon size="rail" />}
            active={pane === 'keys'}
            onClick={() => setPane('keys')}
          >
            {t('settings.keysTitle')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<BellIcon size="rail" />}
            active={pane === 'webhooks'}
            onClick={() => setPane('webhooks')}
          >
            {t('settings.webhooksTitle')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<UserIcon size="rail" />}
            active={pane === 'account'}
            onClick={() => setPane('account')}
          >
            {t('settings.accountTitle')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<MoonIcon size="rail" />}
            active={pane === 'appearance'}
            onClick={() => setPane('appearance')}
          >
            {t('settings.appearanceTitle')}
          </DashNavItem>
        </nav>
        <div className="mt-auto flex items-center gap-2.5 px-1 pt-4">
          <AccountMenu face side="top" align="start" />
        </div>
      </DashSidebar>

      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare" className="md:hidden">
          <Button variant="ghost" size="bar" onClick={() => navigate(back)}>
            <ChevronLeftIcon size="rail" /> {back === '/' ? t('settings.canvases') : t('settings.canvas')}
          </Button>
          <span className="flex-1" />
          <AccountMenu />
        </DashHeader>

        <DashContent className="pt-2 md:pt-7">
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>{t(panes[pane].title)}</DashTitle>
              <DashSubtitle>{t(panes[pane].blurb)}</DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList variant="card">
              <TabsTrigger value="agent">
                <SparkIcon size="rail" /> {t('settings.agentTitle')}
              </TabsTrigger>
              <TabsTrigger value="keys">
                <KeyIcon size="rail" /> {t('settings.keysTitle')}
              </TabsTrigger>
              <TabsTrigger value="webhooks">
                <BellIcon size="rail" /> {t('settings.webhooksTitle')}
              </TabsTrigger>
              <TabsTrigger value="account">
                <UserIcon size="rail" /> {t('settings.accountTab')}
              </TabsTrigger>
              <TabsTrigger value="appearance">
                <MoonIcon size="rail" /> {t('settings.appearanceTitle')}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {pane === 'agent' ? (
            <>
              <SettingsCard>
                <CardHeader>
                  <CardTitle>{t('settings.agentTitle')}</CardTitle>
                  <CardDescription>{t('settings.agentCardDescription')}</CardDescription>
                  {meter && (
                    <div className="mt-[11px] flex flex-col items-start gap-[7px] text-caption text-ink-faint sm:flex-row sm:items-center sm:gap-2.5">
                      {allowance && allowance.limit > 0 && !allowance.byoModel && (
                        <Progress
                          className="w-[min(100%,240px)] sm:w-[180px]"
                          value={left ?? 0}
                          max={allowance.limit}
                          aria-label={t('settings.freeTasksLeftLabel')}
                        />
                      )}
                      <span>{meter}</span>
                    </div>
                  )}
                </CardHeader>
                <ModelAccountPanel onChange={refresh} />
              </SettingsCard>
              <ImageModelCard />
            </>
          ) : pane === 'keys' ? (
            <AgentKeys />
          ) : pane === 'webhooks' ? (
            <Webhooks />
          ) : pane === 'account' ? (
            <AccountSettings />
          ) : (
            <AppearanceSettings />
          )}
        </DashContent>
      </DashMain>
    </DashLayout>
  )
}
