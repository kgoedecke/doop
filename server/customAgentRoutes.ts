import { Router, type Request, type Response } from 'express'
import {
  parseBuiltInAgentPatch,
  parseCustomAgentInput,
  parseCustomAgentPatch,
  type AgentScope,
} from '../shared/customAgents.ts'
import {
  AgentInputError,
  createCustomAgent,
  deleteCustomAgent,
  listBuiltInAgents,
  listCustomAgents,
  resetBuiltInAgent,
  updateBuiltInAgent,
  updateCustomAgent,
} from './customAgents.ts'
import { isWorkspaceMember } from './workspaces.ts'
import { broadcastCustomAgents } from './actions.ts'
import { captureFeature } from './featureEvents.ts'

/** /api/agents: the custom agents Settings and Workspace manage, and under
 *  /api/agents/builtin the same team's changes to the built-in agents. `?workspace=`
 *  names a workspace's (members only); without it they are the signed-in
 *  person's own, used on their personal canvases. The /api session gate
 *  upstream means impersonating admins can look but not change anything. */
export const customAgentsRouter = Router()

/** Whether a person may read and change a scope's agents. */
function canUseAgentScope(scope: AgentScope, userId: string): boolean {
  return 'personal' in scope || isWorkspaceMember(scope.workspaceId, userId)
}

function scopeOf(req: Request, res: Response): AgentScope | null {
  const workspace = req.query.workspace
  const scope: AgentScope = typeof workspace === 'string' && workspace ? { workspaceId: workspace } : { personal: true }
  if (canUseAgentScope(scope, req.user!.id)) return scope
  res.status(403).json({ error: 'you are not a member of this workspace' })
  return null
}

function announce(scope: AgentScope, userId: string) {
  broadcastCustomAgents('workspaceId' in scope ? scope : { ownerId: userId })
}

function failed(res: Response, e: unknown, what: string) {
  if (e instanceof AgentInputError) res.status(400).json({ error: e.message })
  else {
    console.error(`[agents] ${what} failed`, e)
    res.status(500).json({ error: `the agent could not be ${what === 'delete' ? 'removed' : 'saved'} — try again` })
  }
}

customAgentsRouter.get('/', (req, res) => {
  const scope = scopeOf(req, res)
  if (scope) res.json(listCustomAgents(scope, req.user!.id))
})

customAgentsRouter.post('/', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const input = parseCustomAgentInput(req.body)
  if (!input.ok) return res.status(400).json({ error: input.error })
  const userId = req.user!.id
  try {
    const agent = await createCustomAgent(scope, userId, input.value, () => canUseAgentScope(scope, userId))
    announce(scope, userId)
    captureFeature(userId, 'custom_agent_created', 'ui', {
      scope: 'workspaceId' in scope ? 'workspace' : 'personal',
      reviewer: input.value.reviewer,
    })
    res.json(agent)
  } catch (e) {
    failed(res, e, 'create')
  }
})

customAgentsRouter.patch('/:handle', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const patch = parseCustomAgentPatch(req.body)
  if (!patch.ok) return res.status(400).json({ error: patch.error })
  const userId = req.user!.id
  try {
    const agent = await updateCustomAgent(scope, userId, req.params.handle, patch.value, () =>
      canUseAgentScope(scope, userId),
    )
    if (!agent) return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    res.json(agent)
  } catch (e) {
    failed(res, e, 'update')
  }
})

customAgentsRouter.delete('/:handle', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  try {
    if (!(await deleteCustomAgent(scope, userId, req.params.handle, () => canUseAgentScope(scope, userId))))
      return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    res.json({ ok: true })
  } catch (e) {
    failed(res, e, 'delete')
  }
})

/* the built-in agents as this team has them: on or off, and edited */
customAgentsRouter.get('/builtin', (req, res) => {
  const scope = scopeOf(req, res)
  if (scope) res.json(listBuiltInAgents(scope, req.user!.id))
})

customAgentsRouter.patch('/builtin/:id', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const patch = parseBuiltInAgentPatch(req.params.id, req.body)
  if (!patch.ok) return res.status(400).json({ error: patch.error })
  const userId = req.user!.id
  try {
    const agent = await updateBuiltInAgent(scope, userId, req.params.id, patch.value, () =>
      canUseAgentScope(scope, userId),
    )
    if (!agent) return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    if (patch.value.disabled !== undefined)
      captureFeature(userId, 'builtin_agent_toggled', 'ui', { role: req.params.id, enabled: !patch.value.disabled })
    res.json(agent)
  } catch (e) {
    failed(res, e, 'update')
  }
})

/* undo the team's edits to a built-in agent; on or off stays */
customAgentsRouter.delete('/builtin/:id', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  try {
    const agent = await resetBuiltInAgent(scope, userId, req.params.id, () => canUseAgentScope(scope, userId))
    if (!agent) return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    res.json(agent)
  } catch (e) {
    failed(res, e, 'update')
  }
})
