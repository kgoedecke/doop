import { useState } from 'react'
import type { Frame } from '../../shared/types'
import { setFramesApproval } from '../lib/frameApproval'
import { useStore } from '../lib/store'
import { useFrameSaves } from '../lib/frameSaves'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { CheckIcon, ClockIcon } from './ui/icons'
import { Switch } from './ui/switch'
import { Tooltip } from './ui/tooltip'

export function FrameApprovalBadge({ frame, compact = false }: { frame: Frame; compact?: boolean }) {
  const approval = frame.approval
  if (!approval) return null
  const ready = approval.status === 'ready_for_dev'
  const label = ready ? 'Ready for dev' : 'Needs review'
  const Icon = ready ? CheckIcon : ClockIcon
  return (
    <Badge
      tone={ready ? 'success' : 'banned'}
      className="shrink-0"
      title={`${label} · ${ready ? 'Approved' : 'Previously approved'} by ${approval.approvedBy} on ${new Date(approval.approvedAt).toLocaleString()}`}
      aria-label={label}
    >
      <Icon className="size-3" aria-hidden />
      {!compact && label}
    </Badge>
  )
}

export function FrameApprovalControl({
  frame,
  hasUnsavedChanges = false,
}: {
  frame: Frame
  hasUnsavedChanges?: boolean
}) {
  const [saving, setSaving] = useState(false)
  const streaming = useStore((s) => !!s.streams[frame.id])
  const pendingSave = useFrameSaves((s) => !!s.pending[frame.id])
  const awaitingChanges = streaming || pendingSave || hasUnsavedChanges
  const ready = frame.approval?.status === 'ready_for_dev'
  async function save(status: 'ready_for_dev' | 'draft') {
    setSaving(true)
    try {
      await setFramesApproval([frame], status)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Tooltip
        label={
          frame.approval
            ? `${ready ? 'Approved' : 'Previously approved'} by ${frame.approval.approvedBy} on ${new Date(frame.approval.approvedAt).toLocaleString()}`
            : undefined
        }
        side="left"
      >
        <label className="flex h-5 cursor-pointer items-center justify-between gap-2 text-label text-ink-faint">
          Mark as approved
          <Switch
            size="sm"
            className="data-[state=checked]:bg-success"
            aria-label="Mark as approved"
            aria-busy={saving}
            checked={ready}
            disabled={saving || (!ready && awaitingChanges)}
            onCheckedChange={(checked) => void save(checked ? 'ready_for_dev' : 'draft')}
          />
        </label>
      </Tooltip>
      {frame.approval && !ready && (
        <div>
          <FrameApprovalBadge frame={frame} />
        </div>
      )}
      <p className="text-caption text-ink-faint">
        {ready
          ? 'Agents can see this screen is approved for implementation.'
          : frame.approval
            ? 'This design changed after approval. Review it before marking it ready again.'
            : 'Approve this screen to let your team and agents know it’s ready to build.'}
      </p>
      {saving && (
        <p role="status" className="text-caption text-ink-faint">
          Saving…
        </p>
      )}
      {!ready && awaitingChanges && (
        <p className="text-caption text-ink-faint">Wait for changes to finish saving before approving.</p>
      )}
      {frame.approval && !ready && (
        <Button
          size="inline"
          variant="bare"
          className="self-start"
          disabled={saving}
          onClick={() => void save('draft')}
        >
          Move to draft
        </Button>
      )}
    </div>
  )
}
