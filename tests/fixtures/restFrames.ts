/* Browser fixtures seed loaded frames and intercept the app's HTTP saves; no
   actor runtime runs behind them (the actor transport has its own tests). So
   frame creates and edits take the app API here, as they did before actors. */
import { api, req } from '../../src/lib/api.ts'
import { beginFrameSave } from '../../src/lib/frameSaves.ts'
import { useStore } from '../../src/lib/store.ts'
import type { Frame } from '../../shared/types.ts'

api.createFrame = (canvasId: string, input: Partial<Frame> & { name: string }) =>
  req<Frame>(`/api/canvases/${canvasId}/frames`, {
    method: 'POST',
    body: JSON.stringify({
      pageId: useStore.getState().canvas?.id === canvasId ? (useStore.getState().activePageId ?? undefined) : undefined,
      ...input,
    }),
  })

api.updateFrame = async (frameId: string, patch: Partial<Frame>, expectedUpdatedAt?: number) => {
  const finish = ['html', 'width', 'height'].some((key) => key in patch) ? beginFrameSave(frameId) : () => {}
  try {
    return await req<Frame>(`/api/frames/${frameId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, expectedUpdatedAt }),
    })
  } finally {
    finish()
  }
}
