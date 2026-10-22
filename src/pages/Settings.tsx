import { useState } from 'react'
import { navigate } from '../App'
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
import { BellIcon, ArrowLeftIcon, KeyIcon, MoonIcon, WaypointsIcon, UserIcon } from '../components/ui/icons'
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
const panes: Record<Pane, { title: string; blurb: string }> = {
  agent: { title: 'Doop Agent', blurb: 'Manage the provider connections the agent uses on your canvases.' },
  keys: { title: 'Agent keys', blurb: 'Bearer credentials that let headless agents design as you.' },
  webhooks: {
    title: 'Webhooks',
    blurb: 'HTTP calls to your systems when something happens on a canvas you can open.',
  },
  account: { title: 'Your account', blurb: 'Who you are on every canvas — and how you get back into this one.' },
  appearance: {
    title: 'Appearance',
    blurb: 'How Doop looks in this browser: light, dark, or whatever your system is.',
  },
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
  const { allowance, refresh } = useAllowance()
  const left = allowance ? Math.max(0, allowance.limit - allowance.used) : null
  /* arriving from a canvas (the free-tier wall) should not cost you your
     place — only same-origin canvas paths are honoured */
  const from = new URLSearchParams(location.search).get('from')
  const back = from && /^\/c\/[A-Za-z0-9_-]+$/.test(from) ? from : '/'

  const meter = allowance
    ? allowance.byoModel
      ? allowance.byoKind === 'gemini-cloud'
        ? 'Gemini cloud pilot selected — connection managed by your operator.'
        : allowance.byoKind === 'claude-local'
          ? 'Claude CLI selected — runs on your connected desktop.'
          : `Running on your ${allowance.byoKind === 'chatgpt' || !allowance.byoKind ? 'ChatGPT subscription' : `${ACCOUNT_KIND_LABELS[allowance.byoKind]} key`}.`
      : allowance.limit <= 0
        ? 'No free tasks on this server — connect an account to use the Doop Agent.'
        : left === 0
          ? 'Your free tasks are used up.'
          : `${left} of ${allowance.limit} free task${allowance.limit === 1 ? '' : 's'} left.`
    : null

  return (
    <DashLayout className={railLayout}>
      {/* Settings is its own screen: a rail of its panes, and the way back */}
      <DashSidebar variant="rail">
        <DashSidebarBrand />
        <nav className="flex flex-col gap-0.5">
          <DashNavItem density="rail" icon={<ArrowLeftIcon size="rail" />} onClick={() => navigate(back)}>
            {back === '/' ? 'Back to canvases' : 'Back to canvas'}
          </DashNavItem>
        </nav>
        <DashSectionLabel density="rail">Settings</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem
            density="rail"
            icon={<WaypointsIcon size="rail" />}
            active={pane === 'agent'}
            onClick={() => setPane('agent')}
          >
            Doop Agent
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<KeyIcon size="rail" />}
            active={pane === 'keys'}
            onClick={() => setPane('keys')}
          >
            Agent keys
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<BellIcon size="rail" />}
            active={pane === 'webhooks'}
            onClick={() => setPane('webhooks')}
          >
            Webhooks
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<UserIcon size="rail" />}
            active={pane === 'account'}
            onClick={() => setPane('account')}
          >
            Your account
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<MoonIcon size="rail" />}
            active={pane === 'appearance'}
            onClick={() => setPane('appearance')}
          >
            Appearance
          </DashNavItem>
        </nav>
        <div className="mt-auto flex items-center gap-2.5 px-1 pt-4">
          <AccountMenu face side="top" align="start" />
        </div>
      </DashSidebar>

      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare" className="md:hidden">
          <Button variant="ghost" size="bar" onClick={() => navigate(back)}>
            <ArrowLeftIcon size="rail" /> {back === '/' ? 'Canvases' : 'Canvas'}
          </Button>
          <span className="flex-1" />
          <AccountMenu />
        </DashHeader>

        <DashContent className="pt-2 md:pt-7">
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>{panes[pane].title}</DashTitle>
              <DashSubtitle>{panes[pane].blurb}</DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList variant="card">
              <TabsTrigger value="agent">
                <WaypointsIcon size="rail" /> Doop Agent
              </TabsTrigger>
              <TabsTrigger value="keys">
                <KeyIcon size="rail" /> Agent keys
              </TabsTrigger>
              <TabsTrigger value="webhooks">
                <BellIcon size="rail" /> Webhooks
              </TabsTrigger>
              <TabsTrigger value="account">
                <UserIcon size="rail" /> Account
              </TabsTrigger>
              <TabsTrigger value="appearance">
                <MoonIcon size="rail" /> Appearance
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {pane === 'agent' ? (
            <>
              <SettingsCard>
                <CardHeader>
                  <CardTitle>Doop Agent</CardTitle>
                  <CardDescription>
                    Choose how the Doop Agent runs on your canvases: a connected model account or Claude CLI on your
                    desktop. Choose your agent model in the composer. Your provider’s usage limits and charges apply.
                  </CardDescription>
                  {meter && (
                    <div className="mt-[11px] flex flex-col items-start gap-[7px] text-caption text-ink-faint sm:flex-row sm:items-center sm:gap-2.5">
                      {allowance && allowance.limit > 0 && !allowance.byoModel && (
                        <Progress
                          className="w-[min(100%,240px)] sm:w-[180px]"
                          value={left ?? 0}
                          max={allowance.limit}
                          aria-label="Free Doop Agent tasks left"
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
