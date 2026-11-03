import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ApiError, api, errorMessage } from '../lib/api'
import { useT } from '../lib/i18n'
import { posthog } from '../lib/posthog'
import {
  canAddLocalFonts,
  pickLocalFonts,
  readLocalFont,
  type PickedLocalFont,
  type SkippedLocalFont,
} from '../lib/localFonts'
import { MAX_FONT_BYTES, faceLabel, libraryFamilies, type CustomFont } from '../../shared/fonts'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { EmptyState } from './ui/empty-state'
import { cn } from '../lib/utils'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { DesktopIcon, TrashIcon, UploadIcon } from './ui/icons'

const ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2'

/* previews load under an alias of their own: an uploaded "Inter" must never
   replace the Inter the app itself is set in */
const previewFamily = (font: CustomFont) => `doop-preview-${font.id}`
const loadedPreviews = new Set<string>()

function loadPreview(font: CustomFont) {
  if (loadedPreviews.has(font.id)) return
  loadedPreviews.add(font.id)
  try {
    const face = new FontFace(previewFamily(font), `url(${JSON.stringify(font.url)})`, {
      weight: font.weight,
      style: font.style,
    })
    document.fonts.add(face)
    face.load().catch(() => loadedPreviews.delete(font.id))
  } catch {
    loadedPreviews.delete(font.id)
  }
}

/** The face a family's preview line is set in: its regular, else the first. */
function previewFace(faces: CustomFont[]): CustomFont | undefined {
  return faces.find((f) => f.style === 'normal' && (f.weight === '400' || f.weight.includes(' '))) ?? faces[0]
}

/**
 * A font library as a settings card: upload font files, see each family set
 * in itself, remove faces. `workspaceId` picks a workspace's library (used on
 * its canvases); without it the card manages the person's own, used on their
 * personal canvases.
 */
export function FontLibrary({ workspaceId }: { workspaceId?: string }) {
  const [fonts, setFonts] = useState<CustomFont[] | null>(null)
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState('')
  /* one face, or a whole family (every face it has), awaiting confirmation */
  const [removing, setRemoving] = useState<{ family: string; faces: CustomFont[] } | null>(null)
  const [dragging, setDragging] = useState(false)
  /* fonts picked from this computer in the desktop shell, awaiting the
     licence word before they are read and uploaded */
  const [localPick, setLocalPick] = useState<PickedLocalFont[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const t = useT()

  useEffect(() => {
    let live = true
    api.listFonts(workspaceId).then(
      (list) => live && setFonts(list),
      (e: unknown) => {
        if (!live) return
        setFonts([])
        setError(errorMessage(e, t('fonts.loadFailed')))
      },
    )
    return () => {
      live = false
    }
  }, [workspaceId, t])

  for (const font of fonts ?? []) loadPreview(font)

  async function upload(files: File[]) {
    setError('')
    const problems: string[] = []
    setUploading((n) => n + files.length)
    for (const file of files) {
      try {
        if (file.size > MAX_FONT_BYTES) throw new Error(t('fonts.tooLarge', { name: file.name }))
        const font = await api.uploadFont(file, workspaceId)
        posthog.capture('custom_font_uploaded', { format: font.format, workspace: !!workspaceId })
        setFonts((list) => [
          ...(list ?? []).filter(
            (f) =>
              !(
                f.family.toLowerCase() === font.family.toLowerCase() &&
                f.weight === font.weight &&
                f.style === font.style
              ),
          ),
          font,
        ])
      } catch (e) {
        const failed = t('fonts.uploadFailed')
        const reason = e instanceof ApiError ? errorMessage(e, failed) : e instanceof Error ? e.message : failed
        problems.push(reason.startsWith(file.name) ? reason : `${file.name}: ${reason}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
    if (problems.length) setError(problems.join(' · '))
  }

  async function remove(faces: CustomFont[]) {
    for (const font of faces) {
      try {
        await api.deleteFont(font.id)
        setFonts((list) => list?.filter((f) => f.id !== font.id) ?? null)
      } catch (e) {
        setError(errorMessage(e, t('fonts.removeFailed')))
        return
      }
    }
  }

  /** The desktop shell's native panel, opened in the fonts folder; what it
   *  lets through that is not a single font file is named in the error line. */
  async function chooseLocal() {
    setError('')
    try {
      const { picked, skipped } = await pickLocalFonts()
      const names = (reason: SkippedLocalFont['reason']) =>
        skipped.filter((file) => file.reason === reason).map((file) => file.name)
      const kind = names('kind')
      const size = names('size')
      setError(
        [
          kind.length ? t('fonts.localSkipped', { names: kind.join(', '), count: kind.length }) : '',
          size.length ? t('fonts.localTooLarge', { names: size.join(', '), count: size.length }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      )
      if (picked.length) setLocalPick(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('fonts.uploadFailed'))
    }
  }

  /** Reads each pick through the shell, then uploads like dropped files. */
  async function uploadLocal(picked: PickedLocalFont[]) {
    const files: File[] = []
    const problems: string[] = []
    for (const font of picked) {
      try {
        files.push(await readLocalFont(font))
      } catch {
        problems.push(t('fonts.localReadFailed', { name: font.name }))
      }
    }
    if (files.length) {
      posthog.capture('custom_font_added_from_computer', { count: files.length, workspace: !!workspaceId })
      await upload(files)
    }
    if (problems.length) setError((current) => [current, ...problems].filter(Boolean).join(' · '))
  }

  const families = libraryFamilies(fonts ?? [])
    .sort((a, b) => a.localeCompare(b))
    .map((family) => ({
      family,
      faces: (fonts ?? [])
        .filter((f) => f.family.toLowerCase() === family.toLowerCase())
        .sort((a, b) => a.weight.localeCompare(b.weight) || a.style.localeCompare(b.style)),
    }))

  const busy = fonts === null || uploading > 0
  const uploadButton = (
    <div className="flex flex-wrap justify-end gap-2">
      {canAddLocalFonts() && (
        <Button size="sm" variant="bare" disabled={busy} onClick={() => void chooseLocal()}>
          <DesktopIcon /> {t('fonts.addLocal')}
        </Button>
      )}
      <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
        <UploadIcon /> {uploading > 0 ? t('fonts.uploading') : t('fonts.uploadButton')}
      </Button>
    </div>
  )
  const isFontFile = (file: File) => /\.(ttf|otf|woff2?)$/i.test(file.name)
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

  return (
    <SettingsCard
      className={cn(dragging && 'shadow-[0_0_0_2px_var(--brand)]')}
      /* font files dropped anywhere on the card upload like picked ones */
      onDragOver={(event) => {
        if (busy || !hasFiles(event)) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        setDragging(false)
        const files = [...event.dataTransfer.files]
        if (busy || !files.length) return
        const picked = files.filter(isFontFile)
        if (picked.length) void upload(picked)
        else setError(t('fonts.dropNotFonts'))
      }}
    >
      <CardHeader>
        <CardTitle>{t('fonts.title')}</CardTitle>
        <CardDescription>
          {workspaceId ? t('fonts.descriptionWorkspace') : t('fonts.descriptionPersonal')} {t('fonts.descriptionRest')}
        </CardDescription>
      </CardHeader>

      <Input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        aria-label={t('fonts.chooseFiles')}
        className="hidden"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          if (files.length) void upload(files)
        }}
      />

      {fonts?.length === 0 ? (
        <div className="flex flex-col gap-2 px-4 py-5 sm:px-[22px]">
          <EmptyState
            variant="dashed"
            /* a 1px hairline: the 1.5px default reads heavy inside a card */
            className="border"
            title={t('fonts.emptyTitle')}
            description={workspaceId ? t('fonts.emptyWorkspace') : t('fonts.emptyPersonal')}
            action={uploadButton}
          />
          {error && <Note tone="error">{error}</Note>}
        </div>
      ) : (
        <CardRow label={t('fonts.upload')} action={uploadButton}>
          {error ? (
            <Note tone="error">{error}</Note>
          ) : (
            <Note>
              {fonts === null
                ? t('fonts.loading')
                : `${t('fonts.summary', {
                    families: t('fonts.families', { count: families.length }),
                    files: t('fonts.files', { count: fonts.length }),
                  })} · ${t('fonts.fileRules')}`}
            </Note>
          )}
        </CardRow>
      )}

      {families.map(({ family, faces }) => {
        const preview = previewFace(faces)
        return (
          <CardRow
            key={family}
            label={family}
            action={
              <Button size="sm" variant="bare" onClick={() => setRemoving({ family, faces })}>
                <TrashIcon size="rail" /> {t('fonts.removeFamily')}
              </Button>
            }
          >
            <div className="flex min-w-0 basis-full flex-col gap-1.5">
              <p
                className="truncate text-heading text-ink"
                style={
                  preview
                    ? {
                        fontFamily: `"${previewFamily(preview)}", var(--font-ui)`,
                        fontWeight: preview.weight.split(' ')[0],
                      }
                    : undefined
                }
              >
                {t('fonts.preview')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {faces.map((face) => (
                  <span
                    key={face.id}
                    className="inline-flex items-center gap-1 rounded-pill py-0.5 pl-2.5 pr-0.5 text-caption text-ink-soft shadow-ring"
                    title={face.fileName}
                  >
                    {faceLabel(face)}
                    <IconButton
                      size="sm"
                      shape="round"
                      variant="danger"
                      aria-label={t('fonts.removeFace', { family, face: faceLabel(face) })}
                      onClick={() => setRemoving({ family, faces: [face] })}
                    >
                      <TrashIcon size={12} />
                    </IconButton>
                  </span>
                ))}
              </div>
            </div>
          </CardRow>
        )
      })}

      <ConfirmDialog
        open={localPick !== null}
        onOpenChange={(open) => !open && setLocalPick(null)}
        title={localPick ? t('fonts.addLocalTitle', { count: localPick.length, name: localPick[0]?.name ?? '' }) : ''}
        description={t('fonts.addLocalDescription')}
        confirmLabel={t('fonts.addLocalConfirm')}
        onConfirm={() => {
          if (localPick) void uploadLocal(localPick)
          setLocalPick(null)
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          !removing
            ? ''
            : removing.faces.length === 1 && removing.faces[0]
              ? t('fonts.removeTitle', { family: removing.family, face: faceLabel(removing.faces[0]) })
              : t('fonts.removeFamilyTitle', { family: removing.family, count: removing.faces.length })
        }
        description={
          removing && removing.faces.length > 1 ? t('fonts.removeFamilyDescription') : t('fonts.removeDescription')
        }
        confirmLabel={t('fonts.remove')}
        destructive
        onConfirm={() => {
          if (removing) void remove(removing.faces)
          setRemoving(null)
        }}
      />
    </SettingsCard>
  )
}
