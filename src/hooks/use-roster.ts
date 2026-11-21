import { useEffect, useState } from 'react'
import { AGENT_ROLES, type AgentRole, type Roster } from '../../shared/agents'
import { useStore } from '../lib/store'
import { api } from '../lib/api'

/** The open canvas's team: the built-in agents it has on, then its custom
 *  ones, kept current by the room's `team` messages. */
export function useRoster(): Roster {
  return useStore((s) => s.canvas?.team) ?? AGENT_ROLES
}

/** The team of a canvas that is not open (an automation step's), asked for
 *  once per canvas; the built-in team until the answer, or for no canvas. */
export function useCanvasRoster(canvasId: string | undefined): Roster {
  const [loaded, setLoaded] = useState<{ canvasId: string; team: AgentRole[] } | null>(null)
  useEffect(() => {
    if (!canvasId) return
    let live = true
    api
      .canvasTeam(canvasId)
      .then((team) => {
        if (live) setLoaded({ canvasId, team })
      })
      /* a canvas the person cannot read still lists the built-in team */
      .catch(() => {})
    return () => {
      live = false
    }
  }, [canvasId])
  return canvasId && loaded?.canvasId === canvasId ? loaded.team : AGENT_ROLES
}
