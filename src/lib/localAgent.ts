import { create } from 'zustand'
import { api, ApiError } from './api'
import { useStore } from './store'
import { isClaudeModel, normalizeClaudeModel } from '../../shared/localAgent'
import type { LocalAgentJob, LocalAgentPreference, LocalAgentResult, LocalClaudeModel } from '../../shared/localAgent'

export type NativeStatus = {
  installed: boolean
  connected: boolean
  enabled: boolean
  email?: string | null
  plan?: string | null
  provider?: string | null
  models?: LocalClaudeModel[]
  modelWarning?: string | null
  modelDiscovery?: boolean
  customProfile?: boolean
  model?: string
  configError?: string | null
  authMethod?: string | null
}
type Bridge = {
  __DOOP_CLAUDE_CLI__?: boolean
  __DOOP_CLAUDE_INSTALL__?: boolean
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
    event: { listen: <T>(name: string, callback: (event: { payload: T }) => void) => Promise<() => void> }
  }
}
const bridge = globalThis as Bridge
export const canInstallClaude = () => bridge.__DOOP_CLAUDE_INSTALL__ === true
export const hasLocalClaude = () => bridge.__DOOP_CLAUDE_CLI__ === true

export function invokeClaude<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasLocalClaude() || !bridge.__TAURI__)
    return Promise.reject(new Error('Update the Doop desktop app to use local Claude.'))
  return bridge.__TAURI__.core.invoke<T>(command, args)
}

export const useLocalAgent = create<{
  preference: LocalAgentPreference | null
  native: NativeStatus | null
  running: boolean
  progress: string
  error: string
}>(() => ({ preference: null, native: null, running: false, progress: '', error: '' }))

export async function refreshLocalAgent(userId: string) {
  const [preference, native] = await Promise.all([
    api.localAgent(),
    hasLocalClaude() ? invokeClaude<NativeStatus>('claude_status', { userId }) : Promise.resolve(null),
  ])
  useLocalAgent.setState({ preference, native })
  return { preference, native }
}

export async function selectLocalAgent(userId: string, preference: { enabled: boolean; model: string }) {
  const customProfile = useLocalAgent.getState().native?.customProfile === true
  if (preference.enabled) {
    if (customProfile && !isClaudeModel(preference.model)) throw new Error('Enter a valid model or deployment ID.')
    await invokeClaude('claude_connect', { userId, enabled: true })
    if (customProfile) await invokeClaude('claude_set_model', { userId, model: preference.model })
  }
  // The server dispatches local work but never needs the device's deployment ID.
  const saved = await api.setLocalAgent({
    enabled: preference.enabled,
    model: customProfile ? 'default' : normalizeClaudeModel(preference.model),
  })
  useLocalAgent.setState({ preference: saved })
  if (preference.enabled) await refreshLocalAgent(userId)
  useStore.getState().allowanceChanged()
}

export async function disconnectLocalAgent(userId: string) {
  await api.setLocalAgent({ enabled: false, model: useLocalAgent.getState().preference?.model ?? 'default' })
  await invokeClaude('claude_stop')
  await invokeClaude('claude_connect', { userId, enabled: false })
  await refreshLocalAgent(userId)
  useStore.getState().allowanceChanged()
}

/** Lives above navigation. One random claimant per webview lifetime prevents
 * another device (or a reloaded page) from taking over a still-running process. */
export function startLocalAgent(userId: string): () => void {
  if (!hasLocalClaude()) {
    // Browsers display routing state but never claim work or load a local catalog.
    let disposed = false
    useLocalAgent.setState({ preference: null, native: null, running: false, progress: '', error: '' })
    const refresh = () => {
      api.localAgent().then(
        (preference) => {
          if (!disposed) useLocalAgent.setState({ preference })
        },
        () => {},
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      window.removeEventListener('focus', refresh)
    }
  }
  const deviceId = crypto.randomUUID()
  let disposed = false
  let polling = false
  let activeId: string | null = null
  let completed: { id: string; result: LocalAgentResult } | null = null
  let unlisten: (() => void) | undefined
  useLocalAgent.setState({ preference: null, native: null, running: false, progress: '', error: '' })
  bridge
    .__TAURI__!.event.listen<{ id: string; text: string }>('claude-progress', ({ payload }) => {
      if (!disposed && payload.id === activeId)
        useLocalAgent.setState((s) => ({ progress: (s.progress + payload.text).slice(-6000) }))
    })
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch(() => {})

  const launch = async (job: LocalAgentJob) => {
    activeId = job.id
    useLocalAgent.setState({ running: true, progress: '', error: '' })
    let result: LocalAgentResult
    try {
      result = await invokeClaude<LocalAgentResult>('claude_run', { userId, job })
    } catch (error) {
      result = { success: false, text: String(error) }
    }
    if (disposed) return
    result.text = result.text.slice(0, 100_000)
    completed = { id: job.id, result }
    useLocalAgent.setState({ running: false, progress: result.text, error: result.success ? '' : result.text })
  }

  const poll = async () => {
    if (disposed || polling) return
    polling = true
    try {
      const native = useLocalAgent.getState().native
      if (!native) {
        await refreshLocalAgent(userId)
        return
      }
      if (!native.enabled || !native.connected) return
      if (completed) {
        try {
          await api.finishLocalAgent(completed.id, deviceId, completed.result)
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409)) throw error
        }
        completed = null
        activeId = null
      }
      const { job, enabled } = await api.pollLocalAgent(deviceId)
      if (disposed) return
      if ((!enabled || !job || job.id !== activeId) && activeId) {
        await invokeClaude('claude_stop')
        return
      }
      if (job && !activeId) void launch(job)
    } catch (error) {
      if (!disposed) useLocalAgent.setState({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      polling = false
    }
  }
  void poll()
  const timer = window.setInterval(() => {
    void poll()
  }, 3000)
  return () => {
    disposed = true
    window.clearInterval(timer)
    unlisten?.()
    // Revocation on the server follows lease expiry; never send the old user's
    // result using a newly signed-in browser session.
    invokeClaude('claude_stop').catch(() => {})
  }
}
