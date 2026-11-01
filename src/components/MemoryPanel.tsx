import { useEffect, useState } from 'react'
import type { GuidelineDoc, MemoryReference } from '../../shared/types'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { PanelBody } from './ui/panel'
import { ListHint, ListItem, ListMeta, ListRow, ListSection, ListSummary, ListTitle } from './ui/list'
import { MarkdownBlock, Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { ConfirmDialog } from './ui/alert-dialog'
import { DoopMark } from './Logo'
import { getLocale, t as translate, useT } from '@/lib/i18n'

const MAX_GUIDELINE_CHARS = 24_000
const MAX_TITLE_CHARS = 80

/* Timestamp/author line under a modal heading. */
const meta = 'mt-1.5 text-[11.5px] text-ink-faint'
const errorText = 'mt-2.5 text-[13px] text-accent-ink'
const modalHead = 'flex flex-wrap items-baseline gap-2.5'

/** Pretty display name: explicit title, else the prettified slug. */
function guideTitle(doc: Pick<GuidelineDoc, 'name' | 'title'>): string {
  return doc.title ?? doc.name.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function summarize(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.length > 90 ? line.slice(0, 87) + '…' : line
  }
  return ''
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** The Memory tab in the side panel: the canvas's design brain. References
 *  (pinned exemplar frames), Rules (the style guides), Decisions (captured
 *  feedback) — plus pending distiller proposals to accept or dismiss. */
export function MemoryPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const docs = useStore((s) => s.canvas?.guidelines ?? [])
  const references = useStore((s) => s.canvas?.references ?? [])
  const decisions = useStore((s) => s.decisions)
  const proposals = useStore((s) => s.proposals)
  /* view and comment links read Memory; they do not curate it */
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  /** slug of the open guide, '' = create a new one, null = closed */
  const [openGuide, setOpenGuide] = useState<string | null>(null)
  const [openRef, setOpenRef] = useState<string | null>(null)
  const t = useT()

  if (!canvasId) return null

  const pending = readOnly ? [] : proposals.filter((p) => p.status === 'pending')
  const empty = docs.length === 0 && references.length === 0 && decisions.length === 0 && pending.length === 0

  return (
    <PanelBody className="flex flex-col py-2">
      {empty && (
        <div className="border-b border-line-soft px-4 py-3.5">
          <p className="text-[12.5px] leading-[1.5] font-semibold text-ink">{t('panels.memoryIntro')}</p>
          <ul className="mt-2.5 flex flex-col gap-2 pl-4">
            <li className="text-[12px] leading-[1.5] text-ink-soft">
              <b>{t('panels.memoryReferences')}</b> {t('panels.memoryIntroReferences')}
            </li>
            <li className="text-[12px] leading-[1.5] text-ink-soft">
              <b>{t('panels.memoryRules')}</b> {t('panels.memoryIntroRules')}
            </li>
            <li className="text-[12px] leading-[1.5] text-ink-soft">
              <b>{t('panels.memoryDecisions')}</b> {t('panels.memoryIntroDecisions')}
            </li>
          </ul>
        </div>
      )}

      {pending.map((p) => (
        <div key={p.id} className="mx-4 mt-3 rounded-[12px] border border-brand bg-surface px-3.5 py-3 shadow-card">
          <div className="text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-accent-ink">
            <DoopMark size={11} /> {t('panels.memorySuggestion')}
          </div>
          <div className="mt-1.5 text-[13px] font-semibold leading-[1.45] text-ink">{p.rule.replace(/^-\s*/, '')}</div>
          <div className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-faint">
            {p.rationale} · {t('panels.memoryFromDecisions', { count: p.basedOn.length })} → “
            {p.guideTitle ?? guideTitle({ name: p.guideName })}”
          </div>
          <div className="mt-2.5 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-[11.5px]"
              onClick={() => api.resolveProposal(canvasId, p.id, false).catch(console.error)}
            >
              {t('panels.memoryDismiss')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="text-[11.5px]"
              onClick={() => api.resolveProposal(canvasId, p.id, true).catch(console.error)}
            >
              {t('panels.memoryAddToRules')}
            </Button>
          </div>
        </div>
      ))}

      <ListSection>
        <span>{t('panels.memoryReferences')}</span>
      </ListSection>
      {references.length === 0 ? (
        <ListHint>{t('panels.memoryNoReferences')}</ListHint>
      ) : (
        references.map((r) => (
          <ListRow key={r.id} className="gap-1 py-2.5" onClick={() => setOpenRef(r.id)}>
            <RefThumb reference={r} />
            <ListTitle>{r.title}</ListTitle>
            <ListMeta>
              {r.pinnedBy} · {timeAgo(r.pinnedAt)}
            </ListMeta>
          </ListRow>
        ))
      )}

      <ListSection>
        <span>{t('panels.memoryRules')}</span>
        {!readOnly && (
          <Button
            variant="solid"
            size="sm"
            className="flex-none text-[11.5px] font-bold"
            onClick={() => setOpenGuide('')}
          >
            {t('panels.memoryNew')}
          </Button>
        )}
      </ListSection>
      {docs.length === 0 && <ListHint>{t('panels.memoryRulesHint')}</ListHint>}
      {docs.map((d) => (
        <ListRow key={d.name} onClick={() => setOpenGuide(d.name)}>
          <ListTitle>{guideTitle(d)}</ListTitle>
          <ListSummary>{summarize(d.markdown)}</ListSummary>
          <ListMeta>
            {d.updatedBy} · {timeAgo(d.updatedAt)}
          </ListMeta>
        </ListRow>
      ))}

      {decisions.length > 0 && (
        <>
          <ListSection>
            <span>{t('panels.memoryDecisions')}</span>
          </ListSection>
          {decisions.slice(0, 20).map((d) => (
            <ListItem key={d.id} title={d.summary ? `${d.from}: “${d.text}”` : undefined}>
              <span className="text-[12.5px] leading-[1.45] text-ink">{d.summary ?? `“${d.text}”`}</span>
              <ListMeta>
                {d.from}
                {d.agentName ? ` → ${d.agentName}` : ''} · {timeAgo(d.at)}
                {d.distilledAt ? ` · ${t('panels.memoryDistilled')}` : ''}
              </ListMeta>
            </ListItem>
          ))}
        </>
      )}

      {openGuide !== null && (
        <GuideModal canvasId={canvasId} name={openGuide || null} onClose={() => setOpenGuide(null)} />
      )}
      {openRef !== null && (
        <RefModal
          canvasId={canvasId}
          reference={references.find((r) => r.id === openRef) ?? null}
          onClose={() => setOpenRef(null)}
        />
      )}
    </PanelBody>
  )
}

/** Live thumbnail of a pinned reference: its snapshotted HTML, scaled down. */
function RefThumb({ reference }: { reference: MemoryReference }) {
  const w = 264 // panel content width
  const scale = w / reference.width
  return (
    <span
      className="block w-full overflow-hidden rounded-[8px] border border-line bg-surface"
      style={{ height: Math.min(reference.height * scale, 150) }}
    >
      <iframe
        className="pointer-events-none origin-top-left border-0"
        title={reference.title}
        srcDoc={reference.html}
        sandbox=""
        tabIndex={-1}
        style={{ width: reference.width, height: reference.height, transform: `scale(${scale})` }}
      />
    </span>
  )
}

/** One pinned reference in a modal: full-size preview + unpin. */
function RefModal({
  canvasId,
  reference,
  onClose,
}: {
  canvasId: string
  reference: MemoryReference | null
  onClose: () => void
}) {
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const t = useT()
  if (!reference) {
    return (
      <Modal size="xl" onClose={onClose}>
        <ModalTitle className="sr-only">{t('panels.memoryReference')}</ModalTitle>
        <ModalLede>{t('panels.memoryReferenceGone')}</ModalLede>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </ModalActions>
      </Modal>
    )
  }
  const w = Math.min(696, window.innerWidth - 110)
  const scale = Math.min(1, w / reference.width)
  return (
    <Modal size="xl" onClose={onClose}>
      <>
        <div className={modalHead}>
          <ModalTitle>{reference.title}</ModalTitle>
          <Badge tone="outline" className="rounded-full px-2 py-px">
            {Math.round(reference.width)}×{Math.round(reference.height)}
          </Badge>
        </div>
        <div className={meta}>
          {t('panels.memoryPinnedBy', {
            name: reference.pinnedBy,
            date: new Date(reference.pinnedAt).toLocaleString(getLocale()),
          })}
        </div>
        <div
          className="mt-3.5 overflow-auto rounded-[12px] border border-line bg-surface"
          style={{ height: Math.min(reference.height * scale, window.innerHeight * 0.55) }}
        >
          <iframe
            className="pointer-events-none origin-top-left border-0"
            title={reference.title}
            srcDoc={reference.html}
            sandbox=""
            tabIndex={-1}
            style={{ width: reference.width, height: reference.height, transform: `scale(${scale})` }}
          />
        </div>
        <ModalActions>
          {!readOnly && (
            <Button
              variant="ghost"
              onClick={() => {
                api.unpinReference(canvasId, reference.id).catch(console.error)
                onClose()
              }}
            >
              {t('panels.memoryUnpin')}
            </Button>
          )}
          <ModalSpacer />
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

type Mode = 'read' | 'edit' | 'history'

/** One design guide in a modal: read, edit (title + markdown), version
 *  history with restore, delete. name = null opens in create mode. */
function GuideModal({ canvasId, name, onClose }: { canvasId: string; name: string | null; onClose: () => void }) {
  const doc = useStore((s) => s.canvas?.guidelines?.find((d) => d.name === name) ?? null)
  const creating = name === null
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const [mode, setMode] = useState<Mode>('read')
  const [titleDraft, setTitleDraft] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const t = useT()

  async function save(slug: string, markdown: string, title?: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setGuideline(canvasId, slug, markdown, title)
      if (markdown.trim() && !creating) setMode('read')
      else onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : t('panels.memorySaveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const editing = creating || mode === 'edit'

  return (
    <Modal size="xl" onClose={() => !busy && onClose()}>
      <>
        {editing ? (
          <>
            <ModalTitle className="sr-only">
              {creating ? t('panels.memoryNewRule') : t('panels.memoryEditRule')}
            </ModalTitle>
            <Input
              variant="well"
              inputSize="lg"
              className="font-display font-extrabold md:text-[19px]"
              autoFocus={creating}
              placeholder={t('panels.memoryNamePlaceholder')}
              value={titleDraft}
              maxLength={MAX_TITLE_CHARS}
              disabled={busy}
              onChange={(e) => setTitleDraft(e.target.value)}
            />
            <div className={meta}>
              {t('panels.memoryId')} {creating ? slugify(titleDraft) || '…' : doc?.name}
            </div>
            <Textarea
              className="mt-3 min-h-[38dvh] resize-y rounded-[12px] bg-surface px-4 py-3.5 font-mono leading-[1.65] focus:ring-0 sm:min-h-[46vh] md:text-[12.5px]"
              autoFocus={!creating}
              placeholder={t('panels.memoryRulePlaceholder')}
              value={draft}
              maxLength={MAX_GUIDELINE_CHARS}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
            />
            {error && <p className={errorText}>{error}</p>}
            <ModalActions className="items-center">
              <span className={meta}>
                {draft.length.toLocaleString(getLocale())} / {MAX_GUIDELINE_CHARS.toLocaleString(getLocale())}
              </span>
              <ModalSpacer />
              <Button variant="ghost" disabled={busy} onClick={() => (creating ? onClose() : setMode('read'))}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !draft.trim() || (creating && !slugify(titleDraft))}
                onClick={() =>
                  creating
                    ? save(slugify(titleDraft), draft, titleDraft.trim())
                    : save(doc!.name, draft, titleDraft.trim() || undefined)
                }
              >
                {busy ? t('panels.memorySaving') : t('common.save')}
              </Button>
            </ModalActions>
          </>
        ) : !doc ? (
          /* deleted while open (possibly by someone else) */
          <>
            <ModalTitle className="sr-only">{t('panels.memoryRule')}</ModalTitle>
            <ModalLede>{t('panels.memoryGuideGone')}</ModalLede>
            <ModalActions>
              <Button variant="ghost" onClick={onClose}>
                {t('common.close')}
              </Button>
            </ModalActions>
          </>
        ) : mode === 'history' ? (
          <GuideHistory
            canvasId={canvasId}
            doc={doc}
            busy={busy}
            onRestore={(markdown) => save(doc.name, markdown)}
            onBack={() => setMode('read')}
          />
        ) : (
          <>
            <div className={modalHead}>
              <ModalTitle>{guideTitle(doc)}</ModalTitle>
              <Badge tone="outline" className="rounded-full px-2 py-px">
                {doc.name}
              </Badge>
            </div>
            <div className={meta}>
              {t('panels.memoryEditedBy', {
                name: doc.updatedBy,
                date: new Date(doc.updatedAt).toLocaleString(getLocale()),
              })}
            </div>
            <MarkdownBlock>{doc.markdown}</MarkdownBlock>
            {error && <p className={errorText}>{error}</p>}
            <ModalActions>
              {!readOnly && (
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  {t('common.delete')}
                </Button>
              )}
              <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={t('panels.memoryDeleteTitle', { title: guideTitle(doc) })}
                description={t('panels.memoryDeleteDescription')}
                confirmLabel={t('panels.memoryDeleteConfirm')}
                destructive
                onConfirm={() => save(doc.name, '')}
              />
              <ModalSpacer />
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                {t('common.close')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setMode('history')}>
                {t('panels.memoryHistory')}
              </Button>
              {!readOnly && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    setTitleDraft(guideTitle(doc))
                    setDraft(doc.markdown)
                    setError(null)
                    setMode('edit')
                  }}
                >
                  {t('panels.memoryEdit')}
                </Button>
              )}
            </ModalActions>
          </>
        )}
      </>
    </Modal>
  )
}

function GuideHistory({
  canvasId,
  doc,
  busy,
  onRestore,
  onBack,
}: {
  canvasId: string
  doc: GuidelineDoc
  busy: boolean
  onRestore: (markdown: string) => void
  onBack: () => void
}) {
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const [versions, setVersions] = useState<{ markdown: string; savedAt: number; savedBy: string }[] | null>(null)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  useEffect(() => {
    let alive = true
    api
      .guidelineHistory(canvasId, doc.name)
      .then((h) => alive && setVersions(h))
      .catch(
        (e) =>
          alive &&
          setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : translate('panels.memoryHistoryFailed')),
      )
    return () => {
      alive = false
    }
  }, [canvasId, doc.name])

  const preview = previewIdx !== null ? versions?.[previewIdx] : undefined

  return (
    <>
      <div className={modalHead}>
        <ModalTitle>{t('panels.memoryHistoryTitle', { title: guideTitle(doc) })}</ModalTitle>
      </div>
      {error && <p className={errorText}>{error}</p>}
      {preview ? (
        <>
          <div className={meta}>
            {t(preview.markdown ? 'panels.memorySavedBy' : 'panels.memoryDeletedBy', {
              name: preview.savedBy,
              date: new Date(preview.savedAt).toLocaleString(getLocale()),
            })}
          </div>
          {preview.markdown ? (
            <MarkdownBlock>{preview.markdown}</MarkdownBlock>
          ) : (
            <ModalLede>{t('panels.memoryDeletionVersion')}</ModalLede>
          )}
          <ModalActions>
            <Button variant="ghost" disabled={busy} onClick={() => setPreviewIdx(null)}>
              {t('common.back')}
            </Button>
            <ModalSpacer />
            {!readOnly && (
              <Button
                variant="primary"
                disabled={busy || !preview.markdown || preview.markdown === doc.markdown}
                onClick={() => onRestore(preview.markdown)}
              >
                {busy ? t('panels.memoryRestoring') : t('panels.memoryRestore')}
              </Button>
            )}
          </ModalActions>
        </>
      ) : (
        <>
          <div className="mt-3.5 overflow-hidden rounded-[12px] border border-line bg-surface">
            {versions?.length === 0 && <ModalLede>{t('panels.memoryNoVersions')}</ModalLede>}
            {(versions ?? []).map((v, i) => (
              <ListRow
                key={v.savedAt + v.savedBy}
                className="border-b-0 border-t border-line-soft first:border-t-0"
                onClick={() => setPreviewIdx(i)}
              >
                <ListTitle>
                  {v.markdown === ''
                    ? t('panels.memoryVersionDeleted')
                    : v.markdown === doc.markdown
                      ? t('panels.memoryVersionCurrent')
                      : `v${(versions?.length ?? 0) - i}`}
                </ListTitle>
                <ListSummary>{v.markdown ? summarize(v.markdown) : '—'}</ListSummary>
                <ListMeta>
                  {v.savedBy} · {new Date(v.savedAt).toLocaleString(getLocale())}
                </ListMeta>
              </ListRow>
            ))}
          </div>
          <ModalActions>
            <Button variant="ghost" disabled={busy} onClick={onBack}>
              {t('common.back')}
            </Button>
          </ModalActions>
        </>
      )}
    </>
  )
}
