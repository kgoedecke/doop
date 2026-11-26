import express from 'express'
import { inArray, count } from 'drizzle-orm'
import { store } from './store.ts'
import { isAdmin } from './access.ts'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { listAgentFeedback } from './agentFeedback.ts'
import { agentFeedback } from './db/schema.ts'
import * as workspaces from './workspaces.ts'
import { loadOidcConfig, loginProvidersConfig } from './auth.ts'
import { getInstanceSettings, ssoAdminSignedIn, updateInstanceSettings } from './instanceSettings.ts'
import { isInstanceSettingsPatch } from '../shared/instanceSettings.ts'
import {
  CustomProviderError,
  customConfig,
  customFailure,
  customSecrets,
  discoverCustomModels,
  discoveryEndpoint,
  takeProbeSlot,
  testCustomProvider,
} from './customProviders.ts'
import { CustomProviderUrlError, customProvidersEnabled } from './customProviderFetch.ts'
import {
  SharedProviderError,
  createSharedProvider,
  deleteSharedProvider,
  getSharedProvider,
  listSharedProviders,
  movedSecretsRefusal,
  setSharedProviderEnabled,
  sharedStatusOf,
  updateSharedProvider,
} from './sharedModelAccounts.ts'
import { isCustomProviderKind } from '../shared/customProvider.ts'

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
adminRouter.get('/canvases', async (req, res) => {
  const { total, canvases } = store.listAllCanvases()
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
})

/** The three numbers worth knowing at a glance. */
adminRouter.get('/stats', async (req, res) => {
  const [[users], [reports]] = await Promise.all([
    db.select({ n: count() }).from(authSchema.user),
    db.select({ n: count() }).from(agentFeedback),
  ])
  const canvases = [...store.canvases.values()]
  res.json({
    users: users?.n ?? 0,
    canvases: canvases.length,
    frames: canvases.reduce((n, c) => n + c.frames.length, 0),
    agentFeedback: reports?.n ?? 0,
  })
})

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

/** What agents sent through report_issue and share_feedback, a page at a time,
 *  newest first, with the account they ran for. Filters: kind, q (search),
 *  and before=<at>:<id> (the last report already shown) for older pages. */
adminRouter.get('/agent-feedback', async (req, res) => {
  const kind = req.query.kind === 'issue' || req.query.kind === 'feedback' ? req.query.kind : undefined
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : undefined
  const cursor = typeof req.query.before === 'string' ? /^(\d+):(.+)$/.exec(req.query.before) : null
  const before = cursor ? { at: Number(cursor[1]), id: cursor[2] ?? '' } : undefined
  const page = await listAgentFeedback({ kind, q, before })
  const userIds = [...new Set(page.reports.map((r) => r.userId).filter((id): id is string => !!id))]
  const users = userIds.length
    ? await db
        .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
        .from(authSchema.user)
        .where(inArray(authSchema.user.id, userIds))
    : []
  const byId = new Map(users.map((u) => [u.id, u]))
  res.json({ ...page, reports: page.reports.map((r) => ({ ...r, user: r.userId ? byId.get(r.userId) : undefined })) })
})

/** The sign-in policy with what it depends on: the providers env has wired
 *  up (read-only here), the workspaces a newcomer could be put in, and
 *  whether an admin has come in through SSO (the auto-redirect guard). */
async function instanceSettingsView() {
  return {
    settings: getInstanceSettings(),
    providers: loginProvidersConfig(),
    workspaces: workspaces.listAll(),
    ssoAdminSignedIn: await ssoAdminSignedIn(),
  }
}

adminRouter.get('/instance-settings', async (req, res) => {
  res.json(await instanceSettingsView())
})

/** A partial of InstanceSettings; 400 for a malformed body, 409 with the
 *  reason when the policy itself refuses it (shared/instanceSettings.ts). */
adminRouter.patch('/instance-settings', async (req, res) => {
  if (!isInstanceSettingsPatch(req.body)) return res.status(400).json({ refusal: 'invalid' })
  const result = await updateInstanceSettings(req.body, req.user!.id, loadOidcConfig() !== null)
  if ('refusal' in result) return res.status(409).json({ refusal: result.refusal })
  res.json(await instanceSettingsView())
})

/* ---- shared model providers (server/sharedModelAccounts.ts): custom
   providers set up here once, for every person on the instance. The key and
   header values go in and never come back out, here included: the view says
   which headers are set and whether there is a key. */

async function sharedProvidersView() {
  return {
    providers: (await listSharedProviders()).map(sharedStatusOf),
    /* the operator's switch (DOOP_CUSTOM_PROVIDERS): off hides them from everyone */
    customProviders: customProvidersEnabled(),
  }
}

/** A write's failure: what the admin can fix is said, anything else is a
 *  bare 500 — a database error can quote the row it was writing. */
function sharedFailure(res: express.Response, error: unknown, fallback: string) {
  if (error instanceof SharedProviderError) return res.status(error.status).json({ error: error.message })
  if (error instanceof CustomProviderError || error instanceof CustomProviderUrlError) {
    return res.status(400).json({ error: error.message })
  }
  console.error(`[admin] ${fallback}`)
  return res.status(500).json({ error: fallback })
}

adminRouter.get('/shared-providers', async (req, res) => {
  try {
    res.json(await sharedProvidersView())
  } catch {
    res.status(500).json({ error: 'shared providers unavailable' })
  }
})

/* everything below changes or calls a provider, which the operator's switch forbids */
adminRouter.use('/shared-providers', (_req, res, next) => {
  if (!customProvidersEnabled()) return res.status(404).json({ error: 'custom providers are off on this server' })
  next()
})

/** The secrets a set-up request for `baseUrl` should use: what it carries,
 *  else (for a provider being edited) what is stored for it — and those only
 *  while the request stays on the stored endpoint's origin. */
async function sharedProbeSecrets(body: Record<string, unknown>, baseUrl: string) {
  const given = customSecrets(body)
  const stored = isCustomProviderKind(body.kind) ? await getSharedProvider(body.kind) : null
  if (stored) {
    const refusal = movedSecretsRefusal(
      { baseUrl: stored.custom.baseUrl, hasKey: !!stored.apiKey, hasHeaders: !!stored.headers },
      baseUrl,
      given,
    )
    if (refusal) throw new CustomProviderError(refusal)
  }
  const apiKey = given.apiKey ?? stored?.apiKey
  const headers = given.headers ?? stored?.headers
  return { ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) }
}

/* the endpoint's own model list, to fill the form's rows */
adminRouter.post('/shared-providers/models', async (req, res) => {
  if (!takeProbeSlot(req.user!.id)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const endpoint = discoveryEndpoint(body)
    const models = await discoverCustomModels({
      config: endpoint,
      ...(await sharedProbeSecrets(body, endpoint.baseUrl)),
    })
    res.json({ models })
  } catch (error) {
    customFailure(res, error, 'could not list that endpoint’s models')
  }
})

/* one short turn that has to call a tool: the agent cannot work without it */
adminRouter.post('/shared-providers/test', async (req, res) => {
  if (!takeProbeSlot(req.user!.id)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const config = customConfig(body)
    const model = config.models.find((option) => option.id === body.model) ?? config.models[0]
    if (!model) throw new CustomProviderError('Add a model to test')
    await testCustomProvider({ config, ...(await sharedProbeSecrets(body, config.baseUrl)) }, model)
    res.json({ ok: true, model: model.id })
  } catch (error) {
    customFailure(res, error, 'the test turn failed')
  }
})

adminRouter.post('/shared-providers', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    await createSharedProvider(req.user!.id, customConfig(body), customSecrets(body))
    res.json(await sharedProvidersView())
  } catch (error) {
    sharedFailure(res, error, 'could not add that provider')
  }
})

/* the description, and the key or headers where given: left out keeps them */
adminRouter.put('/shared-providers/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!isCustomProviderKind(kind)) return res.status(400).json({ error: 'unknown provider' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    await updateSharedProvider(req.user!.id, kind, customConfig(body), customSecrets(body))
    res.json(await sharedProvidersView())
  } catch (error) {
    sharedFailure(res, error, 'could not save that provider')
  }
})

/* on or off for everyone, its definition kept */
adminRouter.patch('/shared-providers/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!isCustomProviderKind(kind)) return res.status(400).json({ error: 'unknown provider' })
  const enabled: unknown = req.body?.enabled
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'say whether it is on' })
  try {
    await setSharedProviderEnabled(req.user!.id, kind, enabled)
    res.json(await sharedProvidersView())
  } catch (error) {
    sharedFailure(res, error, 'could not change that provider')
  }
})

/* gone for everyone, with every person's picks on it */
adminRouter.delete('/shared-providers/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!isCustomProviderKind(kind)) return res.status(400).json({ error: 'unknown provider' })
  try {
    if (!(await deleteSharedProvider(kind))) {
      return res.status(404).json({ error: 'That shared provider no longer exists' })
    }
    res.json(await sharedProvidersView())
  } catch (error) {
    sharedFailure(res, error, 'could not remove that provider')
  }
})
