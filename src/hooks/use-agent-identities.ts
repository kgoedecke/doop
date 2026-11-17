import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { isAgentBrandChoice, type AgentBrandChoice } from '../../shared/agentBrand'
import { api } from '../lib/api'

/* The signed-in person's icon choices, keyed by agent name. The Agents panel
   asks for the brand of every row it draws, so the answer lives here: one
   request per process, and a save updates every row at once. */
let choices: Map<string, AgentBrandChoice> | null = null
let loading: Promise<void> | null = null
/* bumped on every change so useSyncExternalStore re-renders its subscribers */
let version = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify() {
  version++
  for (const listener of listeners) listener()
}

/* Every row mounting at once shares the one request. A failure clears it so a
   later mount asks again, and leaves the rows on Automatic until then. */
function loadChoices() {
  if (loading) return loading
  loading = api
    .listAgentIdentities()
    .then((identities) => {
      choices = new Map(identities.map((identity) => [identity.agentName, identity.brand]))
    })
    .catch((err) => {
      console.error(err)
      loading = null
    })
    .finally(notify)
  return loading
}

/** The signed-in person's agent icons: `undefined` means Automatic. */
export function useAgentIdentities() {
  useSyncExternalStore(subscribe, () => version)
  useEffect(() => {
    void loadChoices()
  }, [])

  const brandFor = useCallback((agentName: string | undefined) => (agentName ? choices?.get(agentName) : undefined), [])

  /* null goes back to automatic; the cache takes the server's answer so the
     next render shows the icon that was actually stored */
  const setBrand = useCallback(async (agentName: string, brand: AgentBrandChoice | null) => {
    const saved = await api.setAgentIdentity(agentName, brand)
    const next = new Map(choices ?? [])
    if (isAgentBrandChoice(saved.brand)) next.set(saved.agentName, saved.brand)
    else next.delete(saved.agentName)
    choices = next
    notify()
  }, [])

  return { brandFor, setBrand, loaded: choices !== null }
}
