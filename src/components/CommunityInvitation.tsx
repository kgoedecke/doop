import { useEffect, useId, useState } from 'react'
import {
  canInviteToCommunity,
  claimCommunityInvitation,
  optOutOfCommunityInvitations,
} from '../lib/communityInvitation'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { subscribeToTaskCompletions } from '../lib/ws'
import { Button } from './ui/button'

export function CommunityInvitation({
  canvasId,
  ownerId,
  paused,
  onReview,
}: {
  canvasId: string
  ownerId: string
  paused: boolean
  onReview: () => void
}) {
  const t = useT()
  const titleId = useId()
  const [offered, setOffered] = useState(false)

  useEffect(() => {
    if (paused || offered) return
    return subscribeToTaskCompletions((task) => {
      const { canvas } = useStore.getState()
      if (document.hidden || canvas?.id !== canvasId || !canInviteToCommunity(canvas, task, ownerId)) return
      if (claimCommunityInvitation(ownerId)) setOffered(true)
    })
  }, [canvasId, offered, ownerId, paused])

  if (!offered || paused) return null

  return (
    <section
      data-slot="community-invitation"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        setOffered(false)
      }}
      className="w-full max-w-[340px] rounded-panel bg-surface p-3 shadow-pop"
    >
      <div role="status">
        <h2 id={titleId} className="text-body font-medium text-ink">
          {t('panels.communityInvitationTitle')}
        </h2>
        <p className="mt-1 text-label text-ink-soft">{t('panels.communityInvitationDetail')}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          onClick={() => {
            setOffered(false)
            onReview()
          }}
        >
          {t('panels.communityInvitationReview')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOffered(false)}>
          {t('panels.communityInvitationLater')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            optOutOfCommunityInvitations(ownerId)
            setOffered(false)
          }}
        >
          {t('panels.communityInvitationOptOut')}
        </Button>
      </div>
    </section>
  )
}
