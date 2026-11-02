import type { Frame } from '../../shared/types'
import { api, errorMessage } from './api'
import { useStore } from './store'
import { useFrameSaves } from './frameSaves'

/** Wait for server confirmation: a sign-off must never appear to succeed offline. */
export async function setFramesApproval(frames: Frame[], status: 'ready_for_dev' | 'draft'): Promise<void> {
  let saved = 0
  let failure: string | undefined
  for (const frame of frames) {
    if (
      status === 'ready_for_dev' &&
      (useFrameSaves.getState().pending[frame.id] || useStore.getState().streams[frame.id])
    ) {
      failure = 'Wait for changes to finish saving before approving.'
      continue
    }
    try {
      const updated = await api.setFrameApproval(frame.id, status, frame.updatedAt)
      const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
      // A newer websocket update may arrive before this response. Keep it.
      if (current && current.updatedAt <= updated.updatedAt) {
        useStore.getState().patchFrameLocal(frame.id, {
          approval: updated.approval,
          updatedAt: updated.updatedAt,
          updatedBy: updated.updatedBy,
        })
      }
      saved++
    } catch (err) {
      failure = errorMessage(err, 'Couldn’t update approval. Please try again.')
    }
  }
  if (failure) {
    const prefix = saved ? `${saved} of ${frames.length} screens updated. ` : ''
    useStore.getState().pushNotice(prefix + failure)
  }
}
