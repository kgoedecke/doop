import { useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { closeFeedback, useFeedbackOpen } from '../lib/feedback'
import { useT } from '../lib/i18n'
import { MAX_PRODUCT_FEEDBACK_CHARS } from '../../shared/productFeedback'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Textarea } from './ui/textarea'

/** A short note to the Doop team: one field, sent as an email. */
export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()
  const clean = message.trim()

  async function send() {
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.sendProductFeedback({ message: clean, page: location.pathname })
      setSent(true)
    } catch (caught) {
      setError(errorMessage(caught, t('shell.feedbackFailed')))
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <Modal size="sm" onClose={onClose}>
        <>
          <ModalTitle>{t('shell.feedbackSentTitle')}</ModalTitle>
          <ModalLede>{t('shell.feedbackSentBody')}</ModalLede>
          <ModalActions>
            <Button variant="primary" onClick={onClose}>
              {t('shell.feedbackDone')}
            </Button>
          </ModalActions>
        </>
      </Modal>
    )
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>{t('shell.feedbackTitle')}</ModalTitle>
        <ModalLede>{t('shell.feedbackLede')}</ModalLede>
        <Textarea
          variant="well"
          className="mt-5"
          rows={5}
          autoFocus
          value={message}
          maxLength={MAX_PRODUCT_FEEDBACK_CHARS}
          disabled={busy}
          placeholder={t('shell.feedbackPlaceholder')}
          aria-label={t('shell.feedbackTitle')}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send()
          }}
        />
        {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            {t('shell.feedbackCancel')}
          </Button>
          <Button variant="primary" onClick={send} disabled={busy || !clean}>
            {busy ? t('shell.feedbackSending') : t('shell.feedbackSend')}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/** The one feedback modal every "Feedback" in the app opens (lib/feedback),
 *  mounted once for a signed-in page. */
export function FeedbackHost() {
  const open = useFeedbackOpen()
  if (!open) return null
  return <FeedbackModal onClose={closeFeedback} />
}
