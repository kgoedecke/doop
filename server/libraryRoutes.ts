import express from 'express'
import { store } from './store.ts'
import * as actions from './actions.ts'
import * as library from './library.ts'
import { canvasRole } from './access.ts'
import { isWorkspaceMember } from './workspaces.ts'
import { libraryScopeOf, type LibraryScope } from '../shared/designSystem.ts'

/**
 * The component library over REST (server/library.ts). Every route names
 * its library through the query: `?canvas=<id>` (the library that canvas
 * draws from — what the editor uses) or `?workspace=<id>` (a team's library,
 * from the workspace page). Reading follows the canvas or the workspace;
 * changing follows canEditLibrary. Every answer is the fresh snapshot.
 */
export const libraryRouter = express.Router()

function scopeFor(req: express.Request, res: express.Response, write: boolean): LibraryScope | null {
  const userId = req.user!.id
  const canvasId = typeof req.query.canvas === 'string' ? req.query.canvas : ''
  const workspaceId = typeof req.query.workspace === 'string' ? req.query.workspace : ''
  let scope: LibraryScope
  if (canvasId) {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) {
      res.status(404).json({ error: 'not found' })
      return null
    }
    if (!canvasRole(userId, canvas)) {
      res.status(403).json({ error: 'this canvas is private — ask the owner for access' })
      return null
    }
    scope = libraryScopeOf(canvas)
  } else if (workspaceId) {
    if (!isWorkspaceMember(workspaceId, userId)) {
      res.status(404).json({ error: 'workspace not found' })
      return null
    }
    scope = `workspace:${workspaceId}`
  } else {
    res.status(400).json({ error: 'name a canvas or a workspace' })
    return null
  }
  if (write && !library.canEditLibrary(userId, scope)) {
    res.status(403).json({ error: libraryDenied(scope) })
    return null
  }
  return scope
}

function libraryDenied(scope: LibraryScope): string {
  if (scope.startsWith('workspace:')) return 'only members of the workspace can change its components'
  if (scope.startsWith('user:')) return 'only the owner can change their personal components'
  return 'you can view this canvas but not edit it'
}

function actorOf(req: express.Request) {
  return actions.resolveActor({ name: req.user!.name, kind: 'user' })
}

/** Runs a write, restamps the scope's frames and answers with the snapshot. */
function write(
  req: express.Request,
  res: express.Response,
  change: (scope: LibraryScope) => { renamedFrom?: string; slug?: string } | void,
) {
  const scope = scopeFor(req, res, true)
  if (!scope) return
  try {
    const outcome = change(scope) ?? {}
    const renamed = outcome.renamedFrom && outcome.slug ? { from: outcome.renamedFrom, to: outcome.slug } : undefined
    actions.restampLibrary(scope, actorOf(req), renamed)
    res.json(library.snapshot(scope, true))
  } catch (e) {
    if (e instanceof library.LibraryError) return res.status(e.status).json({ error: e.message })
    throw e
  }
}

libraryRouter.get('/', (req, res) => {
  const scope = scopeFor(req, res, false)
  if (!scope) return
  res.json(library.snapshot(scope, library.canEditLibrary(req.user!.id, scope)))
})

libraryRouter.put('/styles', (req, res) => {
  write(req, res, (scope) => {
    library.saveStyles(scope, { globalCss: req.body?.globalCss, notes: req.body?.notes }, req.user!.name)
  })
})

libraryRouter.post('/groups', (req, res) => {
  write(req, res, (scope) => {
    library.createGroup(scope, { name: req.body?.name, description: req.body?.description })
  })
})

libraryRouter.patch('/groups/:id', (req, res) => {
  write(req, res, (scope) => {
    library.updateGroup(scope, req.params.id, { name: req.body?.name, description: req.body?.description })
  })
})

libraryRouter.delete('/groups/:id', (req, res) => {
  write(req, res, (scope) => library.deleteGroup(scope, req.params.id))
})

libraryRouter.post('/components', (req, res) => {
  write(req, res, (scope) => {
    library.saveComponent(scope, req.body ?? {}, req.user!.name)
  })
})

libraryRouter.put('/components/:id', (req, res) => {
  write(req, res, (scope) => {
    const { component, renamedFrom } = library.saveComponent(scope, req.body ?? {}, req.user!.name, req.params.id)
    return { renamedFrom, slug: component.slug }
  })
})

libraryRouter.delete('/components/:id', (req, res) => {
  write(req, res, (scope) => {
    library.deleteComponent(scope, req.params.id)
  })
})
