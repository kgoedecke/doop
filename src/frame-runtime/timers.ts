/* The timers the runtime's own code runs on. Each call reaches the window's
   function as it stands at that moment, exactly as the global names did when
   the runtime was one hand-written closure. They live in one module so the
   runtime can take its timers from elsewhere than the design's scripts do,
   should a design ever need to be held still without holding the runtime. */

export function setTimeout(handler: () => void, ms: number): number {
  return window.setTimeout(handler, ms)
}

export function clearTimeout(id: number | null | undefined): void {
  window.clearTimeout(id ?? undefined)
}

export function requestAnimationFrame(callback: FrameRequestCallback): number {
  return window.requestAnimationFrame(callback)
}
