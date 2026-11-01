import { useDeferredValue, useState, type KeyboardEvent } from 'react'
import {
  COMPONENT_SLUG_RE,
  slugify,
  type ComponentVariant,
  type LibraryComponent,
  type LibrarySnapshot,
} from '../../../shared/designSystem'
import { hasPreset, presetFor } from '../../../shared/componentPresets'
import { errorMessage, type ComponentDraft } from '../../lib/api'
import { groupLabel } from '../../lib/library'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Field } from '../ui/field'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { IconButton } from '../ui/icon-button'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from '../ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { ConfirmDialog } from '../ui/alert-dialog'
import { PlusIcon, TrashIcon } from '../ui/icons'
import { ComponentPreview } from './ComponentPreview'

/** A new component starts in a group, optionally from a preset kind. */
export interface ComponentSeed {
  groupId: string
  kind?: string
}

/* Select cannot hold '' as a value, so "no kind" needs its own */
const NO_KIND = '__none__'
const DEFAULT_PREVIEW = '__default__'

function freeSlug(base: string, taken: ReadonlySet<string>): string {
  const root = base || 'component'
  if (!taken.has(root)) return root
  let n = 2
  while (taken.has(`${root}-${n}`)) n++
  return `${root}-${n}`
}

function seedDraft(seed: ComponentSeed, taken: ReadonlySet<string>, blankName: string): ComponentDraft {
  const slug = freeSlug(slugify(seed.kind ?? 'component'), taken)
  const preset = presetFor(seed.kind, slug)
  return {
    name: seed.kind ? seed.kind.replace(/([a-z])([A-Z])/g, '$1 $2') : blankName,
    slug,
    groupId: seed.groupId,
    kind: seed.kind,
    description: preset.description,
    html: preset.html,
    css: preset.css,
    js: preset.js,
    variants: preset.variants,
  }
}

function draftOf(component: LibraryComponent): ComponentDraft {
  const { name, slug, groupId, kind, description, html, css, js, variants } = component
  return { name, slug, groupId, kind, description, html, css, js, variants }
}

/** Tab in a code field indents instead of leaving it. */
function indentOnTab(event: KeyboardEvent<HTMLTextAreaElement>, onChange: (value: string) => void) {
  if (event.key !== 'Tab' || event.shiftKey) return
  event.preventDefault()
  const field = event.currentTarget
  const { selectionStart: start, selectionEnd: end, value } = field
  onChange(`${value.slice(0, start)}  ${value.slice(end)}`)
  requestAnimationFrame(() => field.setSelectionRange(start + 2, start + 2))
}

function CodeField({
  label,
  value,
  onChange,
  placeholder,
  readOnly,
  rows = 14,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  readOnly?: boolean
  rows?: number
}) {
  return (
    <Textarea
      variant="code"
      aria-label={label}
      spellCheck={false}
      rows={rows}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      className="rounded-control"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => indentOnTab(event, onChange)}
    />
  )
}

/**
 * Creates or edits one component: identity, markup, CSS, JS and variants on
 * the left, a live preview through the real stamp on the right. A component
 * started from a preset kind follows its slug until its code is touched.
 */
export function ComponentEditor({
  snapshot,
  component,
  seed,
  onSave,
  onDelete,
  onClose,
}: {
  snapshot: LibrarySnapshot
  component?: LibraryComponent
  seed?: ComponentSeed
  onSave: (draft: ComponentDraft, id?: string) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const taken = new Set(snapshot.components.filter((c) => c.id !== component?.id).map((c) => c.slug))
  const [draft, setDraft] = useState<ComponentDraft>(() =>
    component ? draftOf(component) : seedDraft(seed ?? { groupId: 'buttons' }, taken, t('library.newComponent')),
  )
  const [codeTouched, setCodeTouched] = useState(!!component)
  const [preview, setPreview] = useState(DEFAULT_PREVIEW)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const readOnly = !snapshot.canEdit

  const shown = useDeferredValue(draft)
  const group = snapshot.groups.find((g) => g.id === draft.groupId)
  const slugProblem = !COMPONENT_SLUG_RE.test(draft.slug)
    ? t('library.slugInvalid')
    : taken.has(draft.slug)
      ? t('library.slugTaken')
      : null

  const set = (patch: Partial<ComponentDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const setCode = (patch: Partial<ComponentDraft>) => {
    setCodeTouched(true)
    set(patch)
  }
  const setSlug = (slug: string) => {
    if (!codeTouched && !component) {
      const preset = presetFor(draft.kind, slug)
      set({ slug, html: preset.html, css: preset.css, js: preset.js, variants: preset.variants })
    } else set({ slug })
  }
  const resetToStarter = () => {
    const preset = presetFor(draft.kind, draft.slug)
    set({ html: preset.html, css: preset.css, js: preset.js, variants: preset.variants })
    setCodeTouched(false)
  }
  const setVariant = (index: number, patch: Partial<ComponentVariant>) =>
    setCode({ variants: draft.variants.map((v, i) => (i === index ? { ...v, ...patch } : v)) })
  const variantLabel = (variant: ComponentVariant, i: number) =>
    variant.name || t('library.variantNumbered', { n: i + 1 })

  const previewMarkup = shown.variants.find((v, i) => variantLabel(v, i) === preview)?.html ?? shown.html

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await onSave(draft, component?.id)
      onClose()
    } catch (caught) {
      setError(errorMessage(caught, t('library.saveFailed')))
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} className="max-w-[min(1120px,calc(100vw-24px))]">
      <ModalTitle>
        {component
          ? component.name
          : draft.kind
            ? t('library.newKind', { kind: draft.kind })
            : t('library.newComponent')}
      </ModalTitle>
      <ModalLede>
        {t('library.editorLedeBefore')} <code className="font-mono">data-doop-component=&quot;{draft.slug}&quot;</code>{' '}
        {t('library.editorLedeAfter')}
      </ModalLede>

      <div className="mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('library.name')} labelVariant="form">
              <Input value={draft.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={t('library.slug')} labelVariant="form" hint={slugProblem ?? undefined}>
              <Input
                variant="mono"
                value={draft.slug}
                disabled={readOnly}
                aria-invalid={!!slugProblem}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
              />
            </Field>
            <Field label={t('library.group')} labelVariant="form">
              <Select
                value={draft.groupId}
                disabled={readOnly}
                onValueChange={(groupId) => set({ groupId, kind: undefined })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {groupLabel(g, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('library.kind')} labelVariant="form">
              <Select
                value={draft.kind ?? NO_KIND}
                disabled={readOnly || !group?.kinds.length}
                onValueChange={(kind) => set({ kind: kind === NO_KIND ? undefined : kind })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_KIND}>{t('library.kindCustom')}</SelectItem>
                  {group?.kinds.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label={t('library.whenToUse')} labelVariant="form">
            <Textarea
              rows={2}
              value={draft.description}
              disabled={readOnly}
              placeholder={t('library.whenToUsePlaceholder')}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>

          <Tabs defaultValue="html">
            <div className="flex items-center gap-2">
              <TabsList>
                <TabsTrigger value="html">HTML</TabsTrigger>
                <TabsTrigger value="css">CSS</TabsTrigger>
                <TabsTrigger value="js">JS</TabsTrigger>
                <TabsTrigger value="variants">{t('library.variantsTab', { count: draft.variants.length })}</TabsTrigger>
              </TabsList>
              <span className="flex-1" />
              {!readOnly && draft.kind && hasPreset(draft.kind) && codeTouched && (
                <Button variant="bare" size="inline" onClick={resetToStarter}>
                  {t('library.resetStarter')}
                </Button>
              )}
            </div>
            <TabsContent value="html">
              <CodeField label="HTML" value={draft.html} readOnly={readOnly} onChange={(html) => setCode({ html })} />
            </TabsContent>
            <TabsContent value="css">
              <CodeField
                label="CSS"
                value={draft.css}
                readOnly={readOnly}
                placeholder={`.${draft.slug} { color: var(--color-primary); }`}
                onChange={(css) => setCode({ css })}
              />
            </TabsContent>
            <TabsContent value="js">
              <CodeField
                label="JS"
                value={draft.js}
                readOnly={readOnly}
                placeholder={t('library.jsPlaceholder')}
                onChange={(js) => setCode({ js })}
              />
            </TabsContent>
            <TabsContent value="variants" className="flex flex-col gap-3">
              {draft.variants.map((variant, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      inputSize="sm"
                      value={variant.name}
                      aria-label={t('library.variantName')}
                      disabled={readOnly}
                      onChange={(e) => setVariant(i, { name: e.target.value })}
                    />
                    {!readOnly && (
                      <IconButton
                        variant="danger"
                        size="sm"
                        aria-label={t('library.removeNamed', { name: variantLabel(variant, i) })}
                        onClick={() => setCode({ variants: draft.variants.filter((_, j) => j !== i) })}
                      >
                        <TrashIcon size="rail" />
                      </IconButton>
                    )}
                  </div>
                  <CodeField
                    label={`${variantLabel(variant, i)} HTML`}
                    rows={4}
                    value={variant.html}
                    readOnly={readOnly}
                    onChange={(html) => setVariant(i, { html })}
                  />
                </div>
              ))}
              {!readOnly && (
                <Button
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    setCode({
                      variants: [
                        ...draft.variants,
                        { name: t('library.variantNumbered', { n: draft.variants.length + 1 }), html: draft.html },
                      ],
                    })
                  }
                >
                  <PlusIcon size="rail" /> {t('library.addVariant')}
                </Button>
              )}
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex min-w-0 flex-col gap-2 md:sticky md:top-0 md:self-start">
          <div className="flex items-center gap-2">
            <span className="text-label font-medium text-ink-soft">{t('library.preview')}</span>
            <span className="flex-1" />
            {draft.variants.length > 0 && (
              <Select value={preview} onValueChange={setPreview}>
                <SelectTrigger size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_PREVIEW}>{t('library.previewDefault')}</SelectItem>
                  {draft.variants.map((v, i) => (
                    <SelectItem key={i} value={variantLabel(v, i)}>
                      {variantLabel(v, i)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="overflow-hidden rounded-card shadow-ring">
            <ComponentPreview
              title={t('library.previewOf', { name: draft.name })}
              globalCss={snapshot.styles.globalCss}
              component={shown}
              markup={previewMarkup}
              className="h-[420px]"
            />
          </div>
          <p className="text-caption text-ink-faint">{t('library.previewNote')}</p>
        </div>
      </div>

      {error && <p className="mt-3 text-body text-accent-ink">{error}</p>}
      <ModalActions>
        {component && onDelete && !readOnly && (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            {t('library.delete')}
          </Button>
        )}
        <ModalSpacer />
        <Button variant="ghost" onClick={onClose}>
          {readOnly ? t('library.close') : t('library.cancel')}
        </Button>
        {!readOnly && (
          <Button
            variant="primary"
            disabled={saving || !!slugProblem || !draft.name.trim()}
            onClick={() => void save()}
          >
            {saving ? t('library.saving') : component ? t('library.saveChanges') : t('library.addToLibrary')}
          </Button>
        )}
      </ModalActions>

      {component && onDelete && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          destructive
          title={t('library.deleteComponentTitle', { name: component.name })}
          description={t('library.deleteComponentBody')}
          confirmLabel={t('library.deleteComponentConfirm')}
          onConfirm={() => {
            onDelete(component.id)
              .then(onClose)
              .catch((caught: unknown) => setError(errorMessage(caught, t('library.deleteFailed'))))
          }}
        />
      )}
    </Modal>
  )
}
