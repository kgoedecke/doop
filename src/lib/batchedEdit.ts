/** Send the latest edit within 50ms, even during continuous typing. */
export function batchedEdit() {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: (() => void) | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const run = pending
    pending = undefined
    run?.()
  }
  return {
    schedule(run: () => void) {
      pending = run
      timer ??= setTimeout(flush, 50)
    },
    flush,
  }
}
