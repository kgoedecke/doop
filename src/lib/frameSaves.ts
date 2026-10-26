import { create } from 'zustand'

/** Includes queued editor drafts and requests in flight, across all controls. */
export const useFrameSaves = create<{ pending: Record<string, number> }>(() => ({ pending: {} }))

export function beginFrameSave(frameId: string): () => void {
  useFrameSaves.setState(({ pending }) => ({ pending: { ...pending, [frameId]: (pending[frameId] ?? 0) + 1 } }))
  let finished = false
  return () => {
    if (finished) return
    finished = true
    useFrameSaves.setState(({ pending }) => {
      const next = { ...pending }
      if ((next[frameId] ?? 0) > 1) next[frameId] = next[frameId]! - 1
      else delete next[frameId]
      return { pending: next }
    })
  }
}
