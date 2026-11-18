import { useEffect, useId, useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { useT } from '../lib/i18n'
import { MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, MAX_SKILLS, type Skill } from '../../shared/skills'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { EmptyState } from './ui/empty-state'
import { Field } from './ui/field'
import { EditIcon, PlusIcon, TrashIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Textarea } from './ui/textarea'

/**
 * A team's skills as a settings card: instructions written once and asked
 * for with `/handle` in a request. `workspaceId` picks a workspace's (on its
 * canvases); without it the card manages the person's own.
 */
export function Skills({ workspaceId }: { workspaceId?: string }) {
  const t = useT()
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [error, setError] = useState('')
  /* null: closed; 'new': the create form; a skill: its edit form. The
     composer's "New skill" arrives with ?skill=new, which opens the form once
     the list shows there is room. */
  const [editing, setEditing] = useState<Skill | 'new' | null>(() =>
    new URLSearchParams(location.search).get('skill') === 'new' ? 'new' : null,
  )
  const [removing, setRemoving] = useState<Skill | null>(null)

  /* the form opened once; a reload or Back to this URL should not open it again */
  useEffect(() => {
    const url = new URL(location.href)
    if (!url.searchParams.has('skill')) return
    url.searchParams.delete('skill')
    history.replaceState(history.state, '', url)
  }, [])

  useEffect(() => {
    let live = true
    api.listSkills(workspaceId).then(
      (list) => {
        if (!live) return
        setSkills(list)
        /* a full scope keeps a ?skill=new form shut; the card says why */
        if (list.length >= MAX_SKILLS) setEditing((open) => (open === 'new' ? null : open))
      },
      (e: unknown) => {
        if (!live) return
        setSkills([])
        setError(errorMessage(e, t('skills.loadFailed')))
      },
    )
    return () => {
      live = false
    }
  }, [workspaceId, t])

  async function remove(skill: Skill) {
    setError('')
    try {
      await api.deleteSkill(skill.handle, workspaceId)
      setSkills((list) => list?.filter((s) => s.handle !== skill.handle) ?? null)
    } catch (e) {
      setError(errorMessage(e, t('skills.removeFailed')))
    }
  }

  function saved(skill: Skill) {
    setSkills((list) =>
      editing === 'new'
        ? [...(list ?? []), skill]
        : (list?.map((s) => (s.handle === skill.handle ? skill : s)) ?? null),
    )
    setEditing(null)
  }

  const full = (skills?.length ?? 0) >= MAX_SKILLS
  const addButton = (
    <Button size="sm" disabled={skills === null || full} onClick={() => setEditing('new')}>
      <PlusIcon /> {t('skills.add')}
    </Button>
  )

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('skills.title')}</CardTitle>
        <CardDescription>
          {workspaceId ? t('skills.descriptionWorkspace') : t('skills.descriptionPersonal')} {t('skills.usage')}
        </CardDescription>
      </CardHeader>

      {skills?.length === 0 ? (
        <div className="flex flex-col gap-2 px-4 py-5 sm:px-[22px]">
          {error && <Note tone="error">{error}</Note>}
          <EmptyState
            variant="dashed"
            className="border"
            title={t('skills.emptyTitle')}
            description={workspaceId ? t('skills.emptyWorkspace') : t('skills.emptyPersonal')}
            action={addButton}
          />
        </div>
      ) : (
        <CardRow label={t('skills.yours')} action={addButton}>
          {error ? (
            <Note tone="error">{error}</Note>
          ) : (
            <Note>
              {skills === null
                ? t('skills.loading')
                : full
                  ? t('skills.full', { count: MAX_SKILLS })
                  : t('skills.count', { count: skills.length })}
            </Note>
          )}
        </CardRow>
      )}

      {skills?.map((skill) => (
        <CardRow
          key={skill.handle}
          label={<span className="truncate font-mono">/{skill.handle}</span>}
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="bare" onClick={() => setEditing(skill)}>
                <EditIcon size="rail" /> {t('skills.edit')}
              </Button>
              <Button size="sm" variant="bare" onClick={() => setRemoving(skill)}>
                <TrashIcon size="rail" /> {t('skills.remove')}
              </Button>
            </div>
          }
        >
          <p className="min-w-0 basis-full truncate text-body text-ink">{skill.description}</p>
        </CardRow>
      ))}

      {editing && skills !== null && (
        <SkillForm
          skill={editing === 'new' ? undefined : editing}
          workspaceId={workspaceId}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? t('skills.removeTitle', { handle: removing.handle }) : ''}
        description={t('skills.removeDescription')}
        confirmLabel={t('skills.remove')}
        destructive
        onConfirm={() => {
          if (removing) void remove(removing)
          setRemoving(null)
        }}
      />
    </SettingsCard>
  )
}

/** Add a skill, or edit one. An existing skill's handle stays: queued work
 *  may name it. */
function SkillForm({
  skill,
  workspaceId,
  onClose,
  onSaved,
}: {
  skill?: Skill
  workspaceId?: string
  onClose: () => void
  onSaved: (skill: Skill) => void
}) {
  const t = useT()
  const ids = useId()
  /* the field's text: empty, or "/" and the handle, so a typed "/" stays and a missing one is added */
  const [handleText, setHandleText] = useState(skill ? `/${skill.handle}` : '')
  const handle = handleText.slice(1)
  const [description, setDescription] = useState(skill?.description ?? '')
  const [body, setBody] = useState(skill?.body ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true)
    setError('')
    try {
      onSaved(
        skill
          ? await api.updateSkill(skill.handle, { description, body }, workspaceId)
          : await api.createSkill({ handle, description, body }, workspaceId),
      )
    } catch (e) {
      setError(errorMessage(e, t('skills.saveFailed')))
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} size="lg">
      <ModalTitle>{skill ? t('skills.editTitle', { handle: skill.handle }) : t('skills.addTitle')}</ModalTitle>
      <ModalLede>{t('skills.formLede')}</ModalLede>
      <form
        className="mt-4 flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label={t('skills.handle')} labelVariant="form" htmlFor={`${ids}-handle`} hint={t('skills.handleHint')}>
          <Input
            id={`${ids}-handle`}
            variant="well"
            className="font-mono"
            value={handleText}
            disabled={!!skill}
            placeholder="/brand-check"
            autoFocus={!skill}
            onChange={(e) => {
              const typed = e.target.value
              setHandleText(typed && `/${typed.toLowerCase().replace(/[^a-z0-9-]/g, '')}`)
            }}
          />
        </Field>
        <Field label={t('skills.description')} labelVariant="form" htmlFor={`${ids}-description`}>
          <Input
            id={`${ids}-description`}
            variant="well"
            value={description}
            maxLength={MAX_SKILL_DESCRIPTION}
            placeholder={t('skills.descriptionPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label={t('skills.body')}
          labelVariant="form"
          htmlFor={`${ids}-body`}
          hint={t('skills.bodyHint', { used: body.length, max: MAX_SKILL_BODY })}
        >
          <Textarea
            id={`${ids}-body`}
            variant="well"
            className="min-h-[200px]"
            value={body}
            maxLength={MAX_SKILL_BODY}
            placeholder={t('skills.bodyPlaceholder')}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {error && <Note tone="error">{error}</Note>}
        <ModalActions className="mt-2">
          <Button type="button" variant="bare" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? t('skills.saving') : skill ? t('skills.save') : t('skills.create')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  )
}
