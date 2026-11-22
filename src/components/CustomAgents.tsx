import { useEffect, useId, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { useT } from '../lib/i18n'
import { posthog } from '../lib/posthog'
import { DEFAULT_ROLE_ID } from '../../shared/agents'
import {
  CUSTOM_AGENT_COLORS,
  MAX_AGENT_BLURB,
  MAX_AGENT_BRIEF,
  MAX_AGENT_NAME,
  MAX_CUSTOM_AGENTS,
  handleFor,
  type BuiltInAgent,
  type CustomAgent,
} from '../../shared/customAgents'
import { RoleMark } from './RoleMark'
import { useSkillMenu } from './SkillMenu'
import { ConfirmDialog } from './ui/alert-dialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { EmptyState } from './ui/empty-state'
import { Field } from './ui/field'
import { EditIcon, PlusIcon, TrashIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Pressable } from './ui/pressable'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
import { cn } from '../lib/utils'

/** What the agent form is open on: a new custom agent, one that exists, or a
 *  built-in agent this team is changing. */
type Editing = { kind: 'new' } | { kind: 'custom'; agent: CustomAgent } | { kind: 'builtin'; agent: BuiltInAgent }

/**
 * A team's Doop Agent roster as a settings card: the built-in agents, each
 * switchable off (Doop excepted) and editable, then the custom agents this
 * team added. `workspaceId` picks a workspace's team (on its canvases);
 * without it the card manages the person's own, on their personal canvases.
 */
export function CustomAgents({ workspaceId }: { workspaceId?: string }) {
  const t = useT()
  const [builtIns, setBuiltIns] = useState<BuiltInAgent[] | null>(null)
  const [agents, setAgents] = useState<CustomAgent[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<CustomAgent | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([api.listBuiltInAgents(workspaceId), api.listCustomAgents(workspaceId)]).then(
      ([team, custom]) => {
        if (!live) return
        setBuiltIns(team)
        setAgents(custom)
      },
      (e: unknown) => {
        if (!live) return
        setBuiltIns([])
        setAgents([])
        setError(errorMessage(e, t('agents.loadFailed')))
      },
    )
    return () => {
      live = false
    }
  }, [workspaceId, t])

  function replaceBuiltIn(agent: BuiltInAgent) {
    setBuiltIns((list) => list?.map((a) => (a.id === agent.id ? agent : a)) ?? null)
  }

  async function toggle(agent: BuiltInAgent, enabled: boolean) {
    setError('')
    /* flips at once; a refusal puts it back */
    replaceBuiltIn({ ...agent, enabled })
    try {
      replaceBuiltIn(await api.updateBuiltInAgent(agent.id, { disabled: !enabled }, workspaceId))
    } catch (e) {
      replaceBuiltIn(agent)
      setError(errorMessage(e, t('agents.saveFailed')))
    }
  }

  async function remove(agent: CustomAgent) {
    setError('')
    try {
      await api.deleteCustomAgent(agent.id, workspaceId)
      setAgents((list) => list?.filter((a) => a.id !== agent.id) ?? null)
    } catch (e) {
      setError(errorMessage(e, t('agents.removeFailed')))
    }
  }

  function saved(agent: CustomAgent | BuiltInAgent) {
    if ('enabled' in agent) replaceBuiltIn(agent)
    else if (editing?.kind === 'new') setAgents((list) => [...(list ?? []), agent])
    else setAgents((list) => list?.map((a) => (a.id === agent.id ? agent : a)) ?? null)
    setEditing(null)
  }

  const full = (agents?.length ?? 0) >= MAX_CUSTOM_AGENTS
  const addButton = (
    <Button size="sm" disabled={agents === null || full} onClick={() => setEditing({ kind: 'new' })}>
      <PlusIcon /> {t('agents.add')}
    </Button>
  )

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('agents.title')}</CardTitle>
        <CardDescription>
          {workspaceId ? t('agents.descriptionWorkspace') : t('agents.descriptionPersonal')}{' '}
          {t('agents.descriptionRest')}
        </CardDescription>
      </CardHeader>

      <CardRow label={t('agents.builtIn')}>
        {error ? <Note tone="error">{error}</Note> : <Note>{t('agents.builtInNote')}</Note>}
      </CardRow>

      {builtIns?.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          off={!agent.enabled}
          badge={
            !agent.enabled ? (
              <Badge tone="outline">{t('agents.off')}</Badge>
            ) : agent.edited ? (
              <Badge tone="outline">{t('agents.edited')}</Badge>
            ) : null
          }
          actions={
            <>
              <Button size="sm" variant="bare" onClick={() => setEditing({ kind: 'builtin', agent })}>
                <EditIcon size="rail" /> {t('agents.edit')}
              </Button>
              <Switch
                size="sm"
                checked={agent.enabled}
                /* everything addressed to no one, and to an agent that is off, goes to Doop */
                disabled={agent.id === DEFAULT_ROLE_ID}
                title={agent.id === DEFAULT_ROLE_ID ? t('agents.defaultStaysOn') : undefined}
                aria-label={t('agents.toggle', { name: agent.name })}
                onCheckedChange={(on) => void toggle(agent, on)}
              />
            </>
          }
        />
      ))}

      {agents?.length === 0 ? (
        <div className="flex flex-col gap-2 px-4 py-5 sm:px-[22px]">
          <EmptyState
            variant="dashed"
            className="border"
            title={t('agents.emptyTitle')}
            description={workspaceId ? t('agents.emptyWorkspace') : t('agents.emptyPersonal')}
            action={addButton}
          />
        </div>
      ) : (
        <CardRow label={t('agents.yours')} action={addButton}>
          <Note>
            {agents === null
              ? t('agents.loading')
              : full
                ? t('agents.full', { count: MAX_CUSTOM_AGENTS })
                : t('agents.count', { count: agents.length })}
          </Note>
        </CardRow>
      )}

      {agents?.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          actions={
            <>
              <Button size="sm" variant="bare" onClick={() => setEditing({ kind: 'custom', agent })}>
                <EditIcon size="rail" /> {t('agents.edit')}
              </Button>
              <Button size="sm" variant="bare" onClick={() => setRemoving(agent)}>
                <TrashIcon size="rail" /> {t('agents.remove')}
              </Button>
            </>
          }
        />
      ))}

      {editing && (
        <AgentForm editing={editing} workspaceId={workspaceId} onClose={() => setEditing(null)} onSaved={saved} />
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? t('agents.removeTitle', { name: removing.name }) : ''}
        description={t('agents.removeDescription')}
        confirmLabel={t('agents.remove')}
        destructive
        onConfirm={() => {
          if (removing) void remove(removing)
          setRemoving(null)
        }}
      />
    </SettingsCard>
  )
}

/** One agent on the card: its mark and name, its handle and one-liner. */
function AgentRow({
  agent,
  off = false,
  badge,
  actions,
}: {
  agent: CustomAgent | BuiltInAgent
  off?: boolean
  badge?: React.ReactNode
  actions: React.ReactNode
}) {
  const t = useT()
  return (
    <CardRow
      label={
        <span className={cn('inline-flex min-w-0 items-center gap-2', off && 'opacity-50')}>
          <RoleMark role={agent} size={16} />
          <span className="truncate">{agent.name}</span>
        </span>
      }
      action={<div className="flex items-center gap-2">{actions}</div>}
    >
      <div className={cn('flex min-w-0 basis-full flex-col gap-0.5', off && 'opacity-50')}>
        <p className="flex min-w-0 items-center gap-2 text-body text-ink">
          <span className="truncate">
            <span className="font-mono text-ink-soft">@{agent.id}</span> · {agent.blurb}
          </span>
          {badge}
        </p>
        {agent.reviewer && <p className="text-caption text-ink-faint">{t('agents.reviewerBadge')}</p>}
      </div>
    </CardRow>
  )
}

/** Add an agent, or edit one. The name and handle of an existing agent stay:
 *  open comments and cards point at them. */
function AgentForm({
  editing,
  workspaceId,
  onClose,
  onSaved,
}: {
  editing: Editing
  workspaceId?: string
  onClose: () => void
  onSaved: (agent: CustomAgent | BuiltInAgent) => void
}) {
  const t = useT()
  const ids = useId()
  const agent = editing.kind === 'new' ? undefined : editing.agent
  const [name, setName] = useState(agent?.name ?? '')
  /* the handle follows the name until someone types one of their own */
  const [handle, setHandle] = useState(agent?.id ?? '')
  const [handleTouched, setHandleTouched] = useState(!!agent)
  const [color, setColor] = useState<string>(agent?.color ?? CUSTOM_AGENT_COLORS[2])
  const [blurb, setBlurb] = useState(agent?.blurb ?? '')
  const [brief, setBrief] = useState(agent?.brief ?? '')
  const briefRef = useRef<HTMLTextAreaElement>(null)
  /* no "New skill" row, since leaving for the skills card would lose this half-edited form */
  const skillMenu = useSkillMenu({
    from: { scope: workspaceId ? { workspaceId } : { personal: true } },
    text: brief,
    setText: setBrief,
    inputRef: briefRef,
  })
  const [reviewer, setReviewer] = useState(agent?.reviewer ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const shownHandle = handleTouched ? handle : handleFor(name)

  async function run(work: () => Promise<CustomAgent | BuiltInAgent>) {
    setSaving(true)
    setError('')
    try {
      onSaved(await work())
    } catch (e) {
      setError(errorMessage(e, t('agents.saveFailed')))
      setSaving(false)
    }
  }

  function save() {
    const fields = { color, blurb, brief, reviewer }
    return run(async () => {
      if (editing.kind === 'builtin') return api.updateBuiltInAgent(editing.agent.id, fields, workspaceId)
      if (editing.kind === 'custom') return api.updateCustomAgent(editing.agent.id, fields, workspaceId)
      const created = await api.createCustomAgent({ name, handle: shownHandle, ...fields }, workspaceId)
      posthog.capture('custom_agent_created_ui', { workspace: !!workspaceId, reviewer })
      return created
    })
  }

  return (
    <Modal
      onClose={onClose}
      size="lg"
      /* the dialog hears Escape before the field does; while the skill menu is open it closes only the menu */
      onEscapeKeyDown={(e) => {
        if (skillMenu.menu && e.target === briefRef.current) e.preventDefault()
      }}
    >
      <ModalTitle>{agent ? t('agents.editTitle', { name: agent.name }) : t('agents.addTitle')}</ModalTitle>
      <ModalLede>{editing.kind === 'builtin' ? t('agents.builtInLede') : t('agents.formLede')}</ModalLede>
      <form
        className="mt-4 flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field
            label={t('agents.name')}
            labelVariant="form"
            htmlFor={`${ids}-name`}
            hint={agent ? t('agents.fixedHint') : undefined}
          >
            <Input
              id={`${ids}-name`}
              variant="well"
              value={name}
              maxLength={MAX_AGENT_NAME}
              disabled={!!agent}
              placeholder={t('agents.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              autoFocus={!agent}
            />
          </Field>
          <Field label={t('agents.handle')} labelVariant="form" htmlFor={`${ids}-handle`}>
            <Input
              id={`${ids}-handle`}
              variant="well"
              className="font-mono"
              value={shownHandle ? `@${shownHandle}` : ''}
              disabled={!!agent}
              placeholder="@seo"
              onChange={(e) => {
                setHandleTouched(true)
                setHandle(
                  e.target.value
                    .replace(/^@+/, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, ''),
                )
              }}
            />
          </Field>
        </div>
        <Field label={t('agents.blurb')} labelVariant="form" htmlFor={`${ids}-blurb`}>
          <Input
            id={`${ids}-blurb`}
            variant="well"
            value={blurb}
            maxLength={MAX_AGENT_BLURB}
            placeholder={t('agents.blurbPlaceholder')}
            onChange={(e) => setBlurb(e.target.value)}
          />
        </Field>
        <Field
          label={t('agents.brief')}
          labelVariant="form"
          htmlFor={`${ids}-brief`}
          hint={t('agents.briefHint', { used: brief.length, max: MAX_AGENT_BRIEF })}
        >
          <div className="relative">
            {skillMenu.menu}
            <Textarea
              ref={briefRef}
              id={`${ids}-brief`}
              variant="well"
              className="min-h-[150px]"
              value={brief}
              maxLength={MAX_AGENT_BRIEF}
              placeholder={t('agents.briefPlaceholder')}
              {...skillMenu.inputProps}
              onKeyDown={skillMenu.onKeyDown}
            />
          </div>
        </Field>
        <Field label={t('agents.color')} labelVariant="form">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('agents.color')}>
            {[...new Set([...(agent ? [agent.color.toUpperCase()] : []), ...CUSTOM_AGENT_COLORS])].map((swatch) => (
              <Pressable
                key={swatch}
                layout="inline"
                focus="ring"
                role="radio"
                aria-checked={color.toUpperCase() === swatch.toUpperCase()}
                aria-label={swatch}
                className={cn(
                  'rounded-full p-0.5',
                  color.toUpperCase() === swatch.toUpperCase() && 'shadow-[0_0_0_2px_var(--ink)]',
                )}
                onClick={() => setColor(swatch)}
              >
                <RoleMark role={{ color: swatch }} size={22} />
              </Pressable>
            ))}
          </div>
        </Field>
        <label className="flex items-start gap-3" htmlFor={`${ids}-reviewer`}>
          <Switch id={`${ids}-reviewer`} checked={reviewer} onCheckedChange={setReviewer} className="mt-0.5" />
          <span className="flex flex-col">
            <span className="text-body font-medium text-ink">{t('agents.reviewer')}</span>
            <span className="text-caption text-ink-faint">{t('agents.reviewerHint')}</span>
          </span>
        </label>
        {error && <Note tone="error">{error}</Note>}
        <ModalActions className="mt-2">
          {editing.kind === 'builtin' && editing.agent.edited && (
            <>
              <Button
                type="button"
                variant="bare"
                disabled={saving}
                onClick={() => void run(() => api.resetBuiltInAgent(editing.agent.id, workspaceId))}
              >
                {t('agents.reset')}
              </Button>
              <ModalSpacer />
            </>
          )}
          <Button type="button" variant="bare" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? t('agents.saving') : agent ? t('agents.save') : t('agents.create')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  )
}
