/**
 * The composer's pick: which of the person's connections the next task goes
 * to, and the model on it. It is this browser's choice (`doop:agent-runner`
 * in localStorage), independent of the Settings default that comments and
 * automations run on, and resolved against what is connected whenever the
 * picker shows it, so a connection that was dropped falls back to the default.
 */
import { create } from 'zustand'
import { api } from './api'
import { useStore } from './store'
import { parseRunnerPick, resolveRunnerPick, type AgentRunners, type RunnerPick } from '../../shared/agentRunner'
import { useEffect } from 'react'

export const RUNNER_PICK_KEY = 'doop:agent-runner'

export function readStoredPick(storage: Pick<Storage, 'getItem'> | undefined): RunnerPick | null {
  try {
    const raw = storage?.getItem(RUNNER_PICK_KEY)
    return raw ? (parseRunnerPick(JSON.parse(raw)) ?? null) : null
  } catch {
    return null
  }
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export const useRunnerPick = create<{
  stored: RunnerPick | null
  runners: AgentRunners | null
  setPick: (pick: RunnerPick) => void
}>((set) => ({
  stored: readStoredPick(storage()),
  runners: null,
  setPick: (pick) => {
    try {
      storage()?.setItem(RUNNER_PICK_KEY, JSON.stringify(pick))
    } catch {
      /* private mode: the pick lives for this page only */
    }
    set({ stored: pick })
  },
}))

/** Asks the server for the connections whenever a mount or a connection
 *  change (`allowanceVersion`) makes the list stale. */
export function useAgentRunners(): AgentRunners | null {
  const version = useStore((s) => s.allowanceVersion)
  const runners = useRunnerPick((s) => s.runners)
  useEffect(() => {
    let stale = false
    api.agentRunners().then(
      (next) => {
        /* an answer without the list (an older server, a stubbed route) is
           nothing connected, never a crash in the composer */
        if (!stale)
          useRunnerPick.setState({ runners: { ...next, runners: Array.isArray(next?.runners) ? next.runners : [] } })
      },
      () => {},
    )
    return () => {
      stale = true
    }
  }, [version])
  return runners
}

/** The pick a card should carry right now, or nothing when the person has
 *  no connection of their own (the card runs on the server tier). */
export function currentRunnerPick(): RunnerPick | undefined {
  const { runners, stored } = useRunnerPick.getState()
  return resolveRunnerPick(runners, stored)?.pick
}
