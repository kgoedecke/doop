import { Router, type Request, type Response } from 'express'
import type { AgentScope } from '../shared/customAgents.ts'
import { parseSkillInput, parseSkillPatch } from '../shared/skills.ts'
import { createSkill, deleteSkill, listSkills, SkillInputError, updateSkill } from './skills.ts'
import { isWorkspaceMember } from './workspaces.ts'

/** /api/skills: the skills Settings and Workspace manage. `?workspace=` names
 *  a workspace's (members only); without it they are the signed-in person's
 *  own, used on their personal canvases. Nothing on a canvas shows skills, so
 *  no room hears about changes: a run reads them when it starts. */
export const skillsRouter = Router()

function canUseScope(scope: AgentScope, userId: string): boolean {
  return 'personal' in scope || isWorkspaceMember(scope.workspaceId, userId)
}

function scopeOf(req: Request, res: Response): AgentScope | null {
  const workspace = req.query.workspace
  const scope: AgentScope = typeof workspace === 'string' && workspace ? { workspaceId: workspace } : { personal: true }
  if (canUseScope(scope, req.user!.id)) return scope
  res.status(403).json({ error: 'you are not a member of this workspace' })
  return null
}

function failed(res: Response, e: unknown, what: string) {
  if (e instanceof SkillInputError) res.status(400).json({ error: e.message })
  else {
    console.error(`[skills] ${what} failed`, e)
    res.status(500).json({ error: `the skill could not be ${what === 'delete' ? 'removed' : 'saved'} — try again` })
  }
}

skillsRouter.get('/', (req, res) => {
  const scope = scopeOf(req, res)
  if (scope) res.json(listSkills(scope, req.user!.id))
})

skillsRouter.post('/', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const input = parseSkillInput(req.body)
  if (!input.ok) return res.status(400).json({ error: input.error })
  const userId = req.user!.id
  try {
    res.json(await createSkill(scope, userId, input.value, () => canUseScope(scope, userId)))
  } catch (e) {
    failed(res, e, 'create')
  }
})

skillsRouter.patch('/:handle', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const patch = parseSkillPatch(req.body)
  if (!patch.ok) return res.status(400).json({ error: patch.error })
  const userId = req.user!.id
  try {
    const skill = await updateSkill(scope, userId, req.params.handle, patch.value, () => canUseScope(scope, userId))
    if (!skill) return res.status(404).json({ error: 'skill not found' })
    res.json(skill)
  } catch (e) {
    failed(res, e, 'update')
  }
})

skillsRouter.delete('/:handle', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  try {
    if (!(await deleteSkill(scope, userId, req.params.handle, () => canUseScope(scope, userId))))
      return res.status(404).json({ error: 'skill not found' })
    res.json({ ok: true })
  } catch (e) {
    failed(res, e, 'delete')
  }
})
