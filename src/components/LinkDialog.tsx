import { useState, type FormEvent } from 'react'
import { useT } from '../lib/i18n'
import { linkSelection, pickedLink } from '../lib/actions/edits'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'

/** A bare host gets https: what a person types as "doop.design" means the site. */
function normalizeHref(value: string): string {
  const v = value.trim()
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('/') || v.startsWith('#')) return v
  return `https://${v}`
}

/** ⇧⌘U: link the picked layers, or take their link off. */
export function LinkDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [existing] = useState(pickedLink)
  const [href, setHref] = useState(existing ?? '')

  function submit(e: FormEvent) {
    e.preventDefault()
    const next = normalizeHref(href)
    linkSelection(next || null)
    onClose()
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <form onSubmit={submit}>
        <ModalTitle>{t('actions.linkTitle')}</ModalTitle>
        <ModalLede>{t('actions.linkLede')}</ModalLede>
        <Input
          autoFocus
          variant="well"
          className="mt-4"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder="https://"
          aria-label={t('actions.linkUrl')}
        />
        <ModalActions>
          {existing !== null && (
            <Button
              variant="ghost"
              onClick={() => {
                linkSelection(null)
                onClose()
              }}
            >
              {t('actions.linkRemove')}
            </Button>
          )}
          <ModalSpacer />
          <Button variant="primary" type="submit" disabled={!href.trim()}>
            {t('actions.linkApply')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  )
}
