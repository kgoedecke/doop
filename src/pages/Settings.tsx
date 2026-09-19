import { useState } from 'react'
import { navigate } from '../App'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { openCanvasTab } from '../lib/desktop'
import { ModelAccountPanel } from '../components/ModelAccount'
import { useAllowance } from '../components/TeamAllowance'
import { AccountSettings } from '../components/AccountSettings'
import { AccountMenu, ConnectCard, IconBack, IconChevron, IconSpark, IconUser } from '../components/DashShell'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { Wordmark } from '../components/ui/wordmark'
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Progress } from '../components/ui/progress'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSidebar,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'

type Pane = 'agent' | 'account'

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
  const [pane, setPane] = useState<Pane>('agent')
  const { allowance, refresh } = useAllowance()
  const left = allowance ? Math.max(0, allowance.limit - allowance.used) : null
  /* arriving from a canvas (the free-tier wall) should not cost you your
     place — only same-origin canvas paths are honoured */
  const from = new URLSearchParams(location.search).get('from')
  const back = from && /^\/c\/[A-Za-z0-9_-]+$/.test(from) ? from : '/'

  async function createCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    if (!openCanvasTab(canvas.id, canvas.name)) navigate(`/c/${canvas.id}`)
  }

  const meter = allowance
    ? allowance.byoModel
      ? allowance.byoKind === 'claude-local'
        ? 'Claude CLI selected — runs on your connected desktop.'
        : `Running on your ${allowance.byoKind === 'anthropic-key' ? 'Claude API key' : allowance.byoKind === 'openai-key' ? 'OpenAI key' : 'ChatGPT subscription'}.`
      : allowance.limit <= 0
        ? 'No free tasks on this server — connect an account to use the Doop Agent.'
        : left === 0
          ? 'Your free tasks are used up.'
          : `${left} of ${allowance.limit} free task${allowance.limit === 1 ? '' : 's'} left.`
    : null

  return (
    <DashLayout>
      <DashSidebar>
        <Wordmark size="sm" className="px-2 pb-5 text-[17px]" />

        <Button
          variant="ghost"
          className="w-full justify-start gap-[9px] rounded-[9px] px-[10px] py-2 text-[13px] text-ink-soft hover:bg-paper hover:text-ink"
          onClick={() => navigate(back)}
        >
          <IconBack /> {back === '/' ? 'Back to canvases' : 'Back to canvas'}
        </Button>

        <DashSectionLabel>Settings</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem icon={<IconSpark />} active={pane === 'agent'} onClick={() => setPane('agent')}>
            Doop Agent
          </DashNavItem>
          <DashNavItem icon={<IconUser />} active={pane === 'account'} onClick={() => setPane('account')}>
            Your account
          </DashNavItem>
        </nav>

        <div className="min-h-6 flex-1" />
        <ConnectCard />
      </DashSidebar>

      <DashMain>
        <DashHeader>
          <nav className="flex items-center gap-2 text-[13px] text-ink-faint" aria-label="Breadcrumb">
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-[13px] font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              Home
            </Button>
            <IconChevron />
            <b className="font-semibold text-ink">Settings</b>
          </nav>
          <span className="flex-1" />
          <Button variant="primary" className="min-h-10 max-xs:px-3 md:min-h-0" onClick={createCanvas}>
            <span className="max-xs:hidden">+ New canvas</span>
            <span className="hidden max-xs:inline">+ New</span>
          </Button>
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>{pane === 'agent' ? 'Doop Agent' : 'Your account'}</DashTitle>
              <DashSubtitle>
                {pane === 'agent'
                  ? 'Which model account the agent runs on, for every canvas you work on.'
                  : 'Who you are on every canvas — and how you get back into this one.'}
              </DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList className="h-10 w-full border border-line bg-surface p-1 shadow-card">
              <TabsTrigger value="agent">
                <IconSpark /> Doop Agent
              </TabsTrigger>
              <TabsTrigger value="account">
                <IconUser /> Your account
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {pane === 'agent' ? (
            <>
              <Card className="mt-4 max-w-[1000px] overflow-hidden sm:mt-5">
                <CardHeader>
                  <CardTitle>Doop Agent</CardTitle>
                  <CardDescription>
                    Choose how the Doop Agent runs on your canvases: a connected model account or Claude CLI on your
                    desktop. Your provider’s usage limits and charges apply.
                  </CardDescription>
                  {meter && (
                    <div className="mt-[11px] flex flex-col items-start gap-[7px] text-[11.5px] text-ink-faint sm:flex-row sm:items-center sm:gap-2.5">
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
              </Card>
            </>
          ) : (
            <AccountSettings />
          )}
        </DashContent>
      </DashMain>
    </DashLayout>
  )
}
