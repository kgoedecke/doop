import { useDeferredValue, useState } from 'react'
import { cssTokens, DEFAULT_GLOBAL_CSS, type LibrarySnapshot } from '../../../shared/designSystem'
import { errorMessage } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from '../ui/modal'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

/* a value a swatch can show: hex, rgb/hsl/oklch, color-mix */
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\(.+\))$/i

/**
 * The design system's global stylesheet and usage rules. The stylesheet's
 * custom properties are listed beside it as the tokens components and agents
 * read; saving restamps every frame that uses the library.
 */
export function GlobalStylesEditor({
  snapshot,
  onSave,
  onClose,
}: {
  snapshot: LibrarySnapshot
  onSave: (styles: { globalCss: string; notes: string }) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [globalCss, setGlobalCss] = useState(snapshot.styles.globalCss)
  const [notes, setNotes] = useState(snapshot.styles.notes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tokens = cssTokens(useDeferredValue(globalCss))
  const readOnly = !snapshot.canEdit

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await onSave({ globalCss, notes })
      onClose()
    } catch (caught) {
      setError(errorMessage(caught, t('library.stylesSaveFailed')))
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} className="max-w-[min(1040px,calc(100vw-24px))]">
      <ModalTitle>{t('library.globalStylesheet')}</ModalTitle>
      <ModalLede>{t('library.stylesLede')}</ModalLede>
      {!snapshot.initialized && <p className="mt-2 text-body text-ink-soft">{t('library.stylesSuggested')}</p>}

      <div className="mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
        <Tabs defaultValue="css">
          <TabsList>
            <TabsTrigger value="css">{t('library.stylesheetTab')}</TabsTrigger>
            <TabsTrigger value="notes">{t('library.rulesTab')}</TabsTrigger>
          </TabsList>
          <TabsContent value="css">
            <Textarea
              variant="code"
              aria-label={t('library.globalStylesheet')}
              spellCheck={false}
              rows={22}
              value={globalCss}
              readOnly={readOnly}
              className="rounded-control"
              onChange={(e) => setGlobalCss(e.target.value)}
            />
          </TabsContent>
          <TabsContent value="notes">
            <Textarea
              rows={22}
              value={notes}
              readOnly={readOnly}
              placeholder={t('library.rulesPlaceholder')}
              onChange={(e) => setNotes(e.target.value)}
            />
            <p className="mt-1.5 text-caption text-ink-faint">{t('library.rulesNote')}</p>
          </TabsContent>
        </Tabs>

        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-label font-medium text-ink-soft">{t('library.tokens', { count: tokens.length })}</span>
          <ul className="flex max-h-[460px] flex-col gap-1 overflow-y-auto">
            {tokens.map((token) => (
              <li key={token.name} className="flex items-center gap-2 text-caption">
                <span
                  aria-hidden
                  className="size-4 flex-none rounded-tag shadow-ring"
                  style={{ background: COLOR_RE.test(token.value) ? token.value : 'transparent' }}
                />
                <code className="min-w-0 flex-1 truncate font-mono text-ink">{token.name}</code>
                <span className="max-w-[90px] truncate font-mono text-ink-faint">{token.value}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {error && <p className="mt-3 text-body text-accent-ink">{error}</p>}
      <ModalActions>
        {!readOnly && (
          <Button variant="bare" onClick={() => setGlobalCss(DEFAULT_GLOBAL_CSS)}>
            {t('library.restoreDefaults')}
          </Button>
        )}
        <ModalSpacer />
        <Button variant="ghost" onClick={onClose}>
          {readOnly ? t('library.close') : t('library.cancel')}
        </Button>
        {!readOnly && (
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? t('library.saving') : t('library.saveStyles')}
          </Button>
        )}
      </ModalActions>
    </Modal>
  )
}
