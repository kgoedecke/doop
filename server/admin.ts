import express from 'express'
import { actorRoute as frameRoute } from './actor-route.ts'
import { inArray, count } from 'drizzle-orm'
import { store } from './store.ts'
import { isAdmin } from './access.ts'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'

/**
 * Instance-admin surface, mounted at /api/admin (so already behind the
 * session gate in index.ts). Read-only by design: it lists what exists, and
 * the way in to a specific canvas is impersonation — better-auth's own
 * /api/auth/admin/impersonate-user — not a privileged read here. That keeps
 * canAccessCanvas the single answer to "may this user see this canvas",
 * which matters because MCP shares it.
 */
export const adminRouter = express.Router()

/* 404 rather than 403: a non-admin should not learn the surface exists. */
adminRouter.use((req, res, next) => {
  if (!isAdmin(req.user)) return res.status(404).end()
  next()
})

/** Every canvas on the instance, newest activity first, with its owner. */
adminRouter.get(
  '/canvases',
  frameRoute(async (req, res) => {
    const { total, canvases } = await store.listAllCanvases()
    const ownerIds = [...new Set(canvases.map((c) => c.ownerId).filter((id): id is string => !!id))]
    const owners = ownerIds.length
      ? await db
          .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
          .from(authSchema.user)
          .where(inArray(authSchema.user.id, ownerIds))
      : []
    const byId = new Map(owners.map((o) => [o.id, o]))
    res.json({
      total,
      canvases: canvases.map((c) => ({ ...c, owner: c.ownerId ? byId.get(c.ownerId) : undefined })),
    })
  }),
)

/** The three numbers worth knowing at a glance. */
adminRouter.get(
  '/stats',
  frameRoute(async (req, res) => {
    const [users] = await db.select({ n: count() }).from(authSchema.user)
    const canvases = (await Promise.all([...store.canvases.keys()].map((id) => store.syncCanvas(id)))).filter(
      (c) => !!c,
    )
    res.json({
      users: users?.n ?? 0,
      canvases: canvases.length,
      frames: canvases.reduce((n, c) => n + c.frames.length, 0),
    })
  }),
)

/** Accounts, for the "view as" picker and (later) ban/role management. */
adminRouter.get('/users', async (req, res) => {
  const rows = await db
    .select({
      id: authSchema.user.id,
      name: authSchema.user.name,
      email: authSchema.user.email,
      role: authSchema.user.role,
      banned: authSchema.user.banned,
      createdAt: authSchema.user.createdAt,
    })
    .from(authSchema.user)
  const owned = new Map<string, number>()
  for (const c of store.canvases.values()) {
    if (c.ownerId) owned.set(c.ownerId, (owned.get(c.ownerId) ?? 0) + 1)
  }
  res.json(
    rows
      .map((u) => ({ ...u, createdAt: u.createdAt.getTime(), canvasCount: owned.get(u.id) ?? 0 }))
      .sort((a, b) => b.createdAt - a.createdAt),
  )
})
