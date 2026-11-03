/* Global bound on concurrent frame renders. Per-frame dedupe caps repeat
   requests but not breadth: a post-restart dashboard of 50 stale canvases,
   a canvas drawing its frames as images (src/lib/frameLod.ts), or an
   anonymous crawler walking known frame URLs would otherwise launch 50
   Chromium pages at once. Excess renders queue, they are not dropped. */
const MAX_CONCURRENT_RENDERS = 3
let active = 0
const waiting: Array<() => void> = []

/** Run `render` once a render slot is free. */
export async function withRenderSlot<T>(render: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_RENDERS) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await render()
  } finally {
    active--
    waiting.shift()?.()
  }
}
