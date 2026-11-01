import { once } from 'node:events'

/** Detect both normal exits and signal termination without waiting on a past event. */
export function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/** Disconnect for graceful shutdown, then forcibly terminate after the grace budget. */
export async function stopChild(child, graceMs = 8000) {
  if (!child || hasExited(child)) return
  const exited = once(child, 'exit')
  if (child.connected) child.disconnect()
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}
