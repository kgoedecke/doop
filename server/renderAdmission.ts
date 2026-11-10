export class RenderBusyError extends Error {
  constructor() {
    super('render capacity is temporarily unavailable')
  }
}

/** One bounded FIFO for each existing resource owner; release transfers its slot. */
export function renderAdmission(capacity: number, maxWaiting = 16, waitMs = 30_000) {
  let active = 0
  const waiting = new Set<{ grant: (release: () => void) => void; timer: ReturnType<typeof setTimeout> }>()
  const releaseOnce = () => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiting.values().next().value
      if (next) {
        waiting.delete(next)
        clearTimeout(next.timer)
        next.grant(releaseOnce())
      } else active--
    }
  }
  return (): Promise<() => void> => {
    if (active < capacity) {
      active++
      return Promise.resolve(releaseOnce())
    }
    if (waiting.size >= maxWaiting) return Promise.reject(new RenderBusyError())
    return new Promise((grant, reject) => {
      const entry = {
        grant,
        timer: setTimeout(() => {
          waiting.delete(entry)
          reject(new RenderBusyError())
        }, waitMs),
      }
      waiting.add(entry)
    })
  }
}
