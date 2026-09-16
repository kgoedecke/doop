import express from 'express'
import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as authSchema from './db/auth-schema.ts'
import { store } from './store.ts'
import * as billing from './billing.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import { isBillingInterval, isWorkspaceActive } from '../shared/billing.ts'
import type { BillingInterval, WorkspaceStatus } from '../shared/billing.ts'
import { isWorkspaceRole } from '../shared/types.ts'
import type {
  WorkspaceDetail,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSummary,
} from '../shared/types.ts'

/**
 * Shared workspaces: the org-level home for canvases. Membership is the
 * whole access model — a member opens every canvas in the workspace — so the
 * membership index lives in memory next to the canvases (canAccessCanvas
 * runs on every request and every MCP call) and is written through to the
 * database the way the store does it.
 *
 * Paid: with Stripe configured (server/billing.ts) a workspace must hold a
 * live per-seat subscription before it can GROW — create canvases, invite,
 * take canvases in. Its existing canvases stay reachable whatever the
 * subscription does; a lapsed card never locks a team out of its work.
 * Without Stripe every workspace is active.
 */

export interface WorkspaceRecord {
  id: string
  name: string
  ownerId: string
  status: WorkspaceStatus
  plan: 'team' | null
  interval: BillingInterval | null
  seats: number
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  billingEventAt: number | null
  createdAt: number
  updatedAt: number
}

interface Membership {
  role: WorkspaceRole
  addedAt: number
}

const records = new Map<string, WorkspaceRecord>()
/** workspaceId -> userId -> membership */
const members = new Map<string, Map<string, Membership>>()

const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[workspaces] write failed', err))
}

export async function hydrateWorkspaces(): Promise<void> {
  const [rows, memberRows] = await Promise.all([db.select().from(t.workspaces), db.select().from(t.workspaceMembers)])
  records.clear()
  members.clear()
  for (const r of rows) {
    records.set(r.id, {
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      status: r.status as WorkspaceStatus,
      plan: r.plan === 'team' ? 'team' : null,
      interval: isBillingInterval(r.interval) ? r.interval : null,
      seats: r.seats,
      stripeCustomerId: r.stripeCustomerId,
      stripeSubscriptionId: r.stripeSubscriptionId,
      currentPeriodEnd: r.currentPeriodEnd,
      cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      billingEventAt: r.billingEventAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })
  }
  for (const m of memberRows) {
    if (!records.has(m.workspaceId) || !isWorkspaceRole(m.role)) continue
    membersOf(m.workspaceId).set(m.userId, { role: m.role, addedAt: m.addedAt })
  }
}

function membersOf(workspaceId: string): Map<string, Membership> {
  let map = members.get(workspaceId)
  if (!map) members.set(workspaceId, (map = new Map()))
  return map
}

/* ---- reads ---- */

export function getWorkspace(id: string): WorkspaceRecord | undefined {
  return records.get(id)
}

export function isWorkspaceMember(workspaceId: string, userId: string | undefined): boolean {
  return !!userId && !!members.get(workspaceId)?.has(userId)
}

export function roleOf(workspaceId: string, userId: string | undefined): WorkspaceRole | undefined {
  return userId ? members.get(workspaceId)?.get(userId)?.role : undefined
}

const RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 }

export function hasRole(workspaceId: string, userId: string | undefined, atLeast: WorkspaceRole): boolean {
  const role = roleOf(workspaceId, userId)
  return !!role && RANK[role] >= RANK[atLeast]
}

export function workspaceIdsFor(userId: string): string[] {
  const ids: string[] = []
  for (const [id, map] of members) if (map.has(userId)) ids.push(id)
  return ids
}

/** Everything the dashboard lists for a user: personal, invited, and every
 *  canvas of every workspace they belong to. */
export function canvasesFor(userId: string) {
  return store.listCanvases(userId, workspaceIdsFor(userId))
}

/** May members grow this workspace right now? */
export function isActive(ws: WorkspaceRecord): boolean {
  return !billing.billingEnabled() || isWorkspaceActive(ws.status)
}

/** 'team' when the user belongs to at least one live paid workspace. */
export function planFor(userId: string): 'free' | 'team' {
  if (!billing.billingEnabled()) return 'free'
  for (const id of workspaceIdsFor(userId)) {
    const ws = records.get(id)
    if (ws && isWorkspaceActive(ws.status)) return 'team'
  }
  return 'free'
}

export function summaryFor(ws: WorkspaceRecord, viewerId: string): WorkspaceSummary {
  return {
    id: ws.id,
    name: ws.name,
    ownerId: ws.ownerId,
    role: roleOf(ws.id, viewerId) ?? 'member',
    status: ws.status,
    active: isActive(ws),
    plan: ws.plan,
    interval: ws.interval,
    seats: ws.seats,
    memberCount: members.get(ws.id)?.size ?? 0,
    canvasCount: store.countWorkspaceCanvases(ws.id),
    ...(ws.currentPeriodEnd ? { currentPeriodEnd: ws.currentPeriodEnd } : {}),
    cancelAtPeriodEnd: ws.cancelAtPeriodEnd,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
  }
}

export function listFor(userId: string): WorkspaceSummary[] {
  return workspaceIdsFor(userId)
    .map((id) => records.get(id))
    .filter((ws): ws is WorkspaceRecord => !!ws)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((ws) => summaryFor(ws, userId))
}

/* ---- writes ---- */

export function createWorkspace(name: string, ownerId: string): WorkspaceRecord {
  const now = Date.now()
  const ws: WorkspaceRecord = {
    id: nanoid(10),
    name,
    ownerId,
    status: 'inactive',
    plan: null,
    interval: null,
    seats: 0,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingEventAt: null,
    createdAt: now,
    updatedAt: now,
  }
  records.set(ws.id, ws)
  membersOf(ws.id).set(ownerId, { role: 'owner', addedAt: now })
  swallow(
    db.transaction(async (tx) => {
      await tx.insert(t.workspaces).values(ws)
      await tx
        .insert(t.workspaceMembers)
        .values({ workspaceId: ws.id, userId: ownerId, role: 'owner', addedBy: ownerId, addedAt: now })
    }),
  )
  return ws
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord | undefined {
  const ws = records.get(id)
  if (!ws) return undefined
  ws.name = name
  ws.updatedAt = Date.now()
  swallow(db.update(t.workspaces).set({ name, updatedAt: ws.updatedAt }).where(eq(t.workspaces.id, id)))
  return ws
}

/** Tear a workspace down: its canvases return to their owners' personal
 *  spaces (nothing is deleted), its subscription is canceled on Stripe. */
export async function deleteWorkspace(id: string): Promise<void> {
  const ws = records.get(id)
  if (!ws) return
  if (billing.billingEnabled()) await billing.cancelSubscription(ws)
  store.detachWorkspace(id)
  records.delete(id)
  members.delete(id)
  await db.transaction(async (tx) => {
    await tx.delete(t.workspaceMembers).where(eq(t.workspaceMembers.workspaceId, id))
    await tx.delete(t.workspaceInvites).where(eq(t.workspaceInvites.workspaceId, id))
    await tx.delete(t.workspaces).where(eq(t.workspaces.id, id))
  })
}

/** Mirror a Stripe subscription onto the row. The one place billing state
 *  changes — the webhook and the post-checkout sync both land here.
 *
 *  Durable before it answers: the webhook must not acknowledge an event
 *  whose write failed (Stripe would never retry it). Ordered: Stripe does
 *  not promise delivery order, so an event older than the last one applied
 *  is dropped rather than rolling a cancellation back to active. Single:
 *  if a different, still-live subscription was on file — two checkouts
 *  completed — the older one is cancelled so nobody is billed twice. */
const billingChains = new Map<string, Promise<unknown>>()

export function applySubscription(
  id: string,
  patch: billing.SubscriptionPatch,
): Promise<{ ws: WorkspaceRecord; applied: boolean } | undefined> {
  /* one at a time per workspace: two overlapping webhooks (or a webhook and
     the post-checkout sync) must not both pass the ordering check on the
     same stale state */
  const next = (billingChains.get(id) ?? Promise.resolve()).then(
    () => applySubscriptionNow(id, patch),
    () => applySubscriptionNow(id, patch),
  )
  billingChains.set(id, next)
  return next
}

async function applySubscriptionNow(
  id: string,
  patch: billing.SubscriptionPatch,
): Promise<{ ws: WorkspaceRecord; applied: boolean } | undefined> {
  const ws = records.get(id)
  if (!ws) return undefined
  /* the ordering guard holds across subscriptions too: a delayed event for
     the subscription this workspace already left must not overwrite the
     current one — or, worse, cancel it as "superseded" */
  if (ws.billingEventAt !== null && patch.billingEventAt < ws.billingEventAt) {
    return { ws, applied: false }
  }
  const sameSubscription = ws.stripeSubscriptionId === patch.stripeSubscriptionId
  const superseded =
    !sameSubscription && ws.stripeSubscriptionId && isWorkspaceActive(ws.status) ? ws.stripeSubscriptionId : null
  const updatedAt = Date.now()
  await db
    .update(t.workspaces)
    .set({ ...patch, updatedAt })
    .where(eq(t.workspaces.id, id))
  Object.assign(ws, patch, { updatedAt })
  if (superseded) {
    console.warn(
      `[billing] workspace ${id} moved to subscription ${patch.stripeSubscriptionId}; cancelling ${superseded}`,
    )
    billing.cancelSubscriptionById(superseded).catch((err) => console.error('[billing] cancel superseded failed', err))
  }
  return { ws, applied: true }
}

export function setCustomer(id: string, stripeCustomerId: string): void {
  const ws = records.get(id)
  if (!ws || ws.stripeCustomerId === stripeCustomerId) return
  ws.stripeCustomerId = stripeCustomerId
  swallow(db.update(t.workspaces).set({ stripeCustomerId }).where(eq(t.workspaces.id, id)))
}

/** Keep Stripe's quantity equal to the member count, in the background:
 *  seat changes must never make the invite itself fail. One chain per
 *  workspace, and the count is read when the update runs, not when it was
 *  queued — so a burst of adds and removes settles on the real number
 *  instead of whichever request finished last. */
const seatChains = new Map<string, Promise<void>>()

function reconcileSeats(ws: WorkspaceRecord): void {
  if (!billing.billingEnabled() || !ws.stripeSubscriptionId) return
  const run = async () => {
    const seats = members.get(ws.id)?.size ?? 0
    if (!records.has(ws.id)) return // deleted while queued
    await billing.syncSeats(ws, seats)
    if (ws.seats !== seats) {
      ws.seats = seats
      await db.update(t.workspaces).set({ seats }).where(eq(t.workspaces.id, ws.id))
    }
  }
  const next = (seatChains.get(ws.id) ?? Promise.resolve())
    .then(run)
    .catch((err) => console.error(`[billing] seat sync failed for workspace ${ws.id}`, err))
  seatChains.set(ws.id, next)
}

export function addMember(workspaceId: string, userId: string, role: WorkspaceRole, addedBy: string): boolean {
  const ws = records.get(workspaceId)
  if (!ws) return false
  const map = membersOf(workspaceId)
  if (map.has(userId)) return false
  const addedAt = Date.now()
  map.set(userId, { role, addedAt })
  swallow(db.insert(t.workspaceMembers).values({ workspaceId, userId, role, addedBy, addedAt }).onConflictDoNothing())
  reconcileSeats(ws)
  return true
}

export function setRole(workspaceId: string, userId: string, role: WorkspaceRole): boolean {
  const entry = members.get(workspaceId)?.get(userId)
  if (!entry) return false
  entry.role = role
  swallow(
    db
      .update(t.workspaceMembers)
      .set({ role })
      .where(and(eq(t.workspaceMembers.workspaceId, workspaceId), eq(t.workspaceMembers.userId, userId))),
  )
  return true
}

/** Unlike an add or a role change, a revocation is durable before it
 *  answers: one that only reached memory would quietly come back at the
 *  next restart, with the member's access to every workspace canvas. */
export async function removeMember(workspaceId: string, userId: string): Promise<boolean> {
  const ws = records.get(workspaceId)
  const map = members.get(workspaceId)
  if (!ws || !map?.has(userId)) return false
  await db
    .delete(t.workspaceMembers)
    .where(and(eq(t.workspaceMembers.workspaceId, workspaceId), eq(t.workspaceMembers.userId, userId)))
  map.delete(userId)
  reconcileSeats(ws)
  return true
}

/* ---- invites for people without an account ---- */

async function createInvite(workspaceId: string, email: string, role: WorkspaceRole, invitedBy: string) {
  const invite = { id: nanoid(12), workspaceId, email, role, invitedBy, createdAt: Date.now() }
  await db
    .insert(t.workspaceInvites)
    .values(invite)
    .onConflictDoUpdate({
      target: [t.workspaceInvites.workspaceId, t.workspaceInvites.email],
      set: { role, invitedBy, createdAt: invite.createdAt },
    })
  return invite
}

async function listInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
  const rows = await db.select().from(t.workspaceInvites).where(eq(t.workspaceInvites.workspaceId, workspaceId))
  const inviterIds = [...new Set(rows.map((r) => r.invitedBy))]
  const names = await userRows(inviterIds)
  return rows
    .map((r) => ({
      id: r.id,
      email: r.email,
      role: isWorkspaceRole(r.role) ? r.role : 'member',
      invitedByName: names.get(r.invitedBy)?.name ?? 'someone',
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Invites can only be honoured for an address someone has proven they
 *  own. With a mailer that is email verification; without one nobody can
 *  ever verify, so in production such invites are refused up front (the
 *  same line ADMIN_EMAILS draws) and local development takes the address
 *  at face value. */
export function unknownEmailInvitesAllowed(): boolean {
  return mailerConfigured || process.env.NODE_ENV !== 'production'
}

/** Turn an invite into a membership: the member row and the invite's
 *  deletion land in one transaction, so a failed write leaves the invite
 *  to retry rather than a person with neither access nor an invite. */
async function acceptInvite(
  ws: WorkspaceRecord,
  userId: string,
  invite: { id: string; role: string; invitedBy: string },
): Promise<void> {
  const role: WorkspaceRole = isWorkspaceRole(invite.role) ? invite.role : 'member'
  const addedAt = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .insert(t.workspaceMembers)
      .values({ workspaceId: ws.id, userId, role, addedBy: invite.invitedBy, addedAt })
      .onConflictDoNothing()
    await tx.delete(t.workspaceInvites).where(eq(t.workspaceInvites.id, invite.id))
  })
  const map = membersOf(ws.id)
  if (!map.has(userId)) {
    map.set(userId, { role, addedAt })
    reconcileSeats(ws)
  }
}

/** A new account with an invited email joins its workspaces on arrival.
 *  Called from the auth hooks — after email verification where a mailer
 *  exists, after signup in mailer-less development. An invite whose
 *  workspace cannot take members right now (no plan, lapsed) is kept, so
 *  reactivating the workspace does not lose the people it invited. */
export async function acceptInvites(userId: string, email: string): Promise<void> {
  const clean = email.trim().toLowerCase()
  const rows = await db.select().from(t.workspaceInvites).where(eq(t.workspaceInvites.email, clean))
  for (const invite of rows) {
    const ws = records.get(invite.workspaceId)
    if (!ws) {
      /* the workspace is gone; nothing to wait for */
      await db.delete(t.workspaceInvites).where(eq(t.workspaceInvites.id, invite.id))
      continue
    }
    if (!isActive(ws)) continue
    await acceptInvite(ws, userId, invite)
  }
}

/** Reactivation catches up on invites whose people signed up meanwhile. */
async function acceptPendingInvitesFor(ws: WorkspaceRecord): Promise<void> {
  const rows = await db.select().from(t.workspaceInvites).where(eq(t.workspaceInvites.workspaceId, ws.id))
  if (!rows.length) return
  const users = await db
    .select({ id: authSchema.user.id, email: authSchema.user.email, emailVerified: authSchema.user.emailVerified })
    .from(authSchema.user)
    .where(
      inArray(
        authSchema.user.email,
        rows.map((r) => r.email),
      ),
    )
  for (const u of users) {
    if (mailerConfigured && !u.emailVerified) continue
    const invite = rows.find((r) => r.email === u.email)
    if (invite) await acceptInvite(ws, u.id, invite)
  }
}

async function userRows(ids: string[]) {
  const rows = ids.length
    ? await db
        .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
        .from(authSchema.user)
        .where(inArray(authSchema.user.id, ids))
    : []
  return new Map(rows.map((r) => [r.id, r]))
}

async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const map = members.get(workspaceId) ?? new Map<string, Membership>()
  const users = await userRows([...map.keys()])
  return [...map]
    .map(([userId, m]) => ({
      userId,
      name: users.get(userId)?.name ?? 'Unknown',
      email: users.get(userId)?.email ?? '',
      role: m.role,
      addedAt: m.addedAt,
    }))
    .sort((a, b) => RANK[b.role] - RANK[a.role] || a.addedAt - b.addedAt)
}

async function detailFor(ws: WorkspaceRecord, viewerId: string): Promise<WorkspaceDetail> {
  const admin = hasRole(ws.id, viewerId, 'admin')
  const [memberList, invites] = await Promise.all([listMembers(ws.id), admin ? listInvites(ws.id) : []])
  return {
    ...summaryFor(ws, viewerId),
    members: memberList,
    invites,
    billing: { enabled: billing.billingEnabled(), portal: !!ws.stripeCustomerId },
  }
}

/* ------------------------------------------------------------------ */
/* Routes: /api/workspaces (behind the session gate in index.ts)       */
/* ------------------------------------------------------------------ */

export const workspacesRouter = express.Router()

/** 402 with a stable error code — every client surface turns this into the
 *  upgrade modal for that workspace. */
export function planRequired(res: express.Response, ws: WorkspaceRecord) {
  return res.status(402).json({
    error: 'workspace_plan_required',
    workspaceId: ws.id,
    message: `"${ws.name}" needs a Team plan before it can grow`,
  })
}

function requireWorkspace(req: express.Request, res: express.Response, id: string, atLeast: WorkspaceRole = 'member') {
  const ws = records.get(id)
  if (!ws || !isWorkspaceMember(id, req.user!.id)) {
    /* 404 for non-members: a workspace's existence is its members' business */
    res.status(404).json({ error: 'workspace not found' })
    return null
  }
  if (!hasRole(id, req.user!.id, atLeast)) {
    res.status(403).json({ error: `only workspace ${atLeast === 'owner' ? 'owners' : 'admins'} can do that` })
    return null
  }
  return ws
}

workspacesRouter.get('/', (req, res) => {
  res.json({ workspaces: listFor(req.user!.id), billing: { enabled: billing.billingEnabled() } })
})

workspacesRouter.post('/', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : ''
  if (!name) return res.status(400).json({ error: 'name required' })
  const ws = createWorkspace(name, req.user!.id)
  res.json(summaryFor(ws, req.user!.id))
})

workspacesRouter.get('/:id', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id)
  if (!ws) return
  res.json(await detailFor(ws, req.user!.id))
})

workspacesRouter.patch('/:id', (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : ''
  if (!name) return res.status(400).json({ error: 'name required' })
  renameWorkspace(ws.id, name)
  res.json(summaryFor(ws, req.user!.id))
})

workspacesRouter.delete('/:id', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'owner')
  if (!ws) return
  try {
    await deleteWorkspace(ws.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('[workspaces] delete failed', err)
    res.status(500).json({ error: 'could not delete the workspace — try again' })
  }
})

/* ---- members ---- */

workspacesRouter.post('/:id/members', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  if (!isActive(ws)) return planRequired(res, ws)
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'a valid email is required' })
  const role: WorkspaceRole = req.body?.role === 'admin' ? 'admin' : 'member'
  const [row] = await db
    .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  if (row) {
    if (!addMember(ws.id, row.id, role, req.user!.id)) return res.status(400).json({ error: 'already a member' })
    const member: WorkspaceMember = { userId: row.id, name: row.name, email: row.email, role, addedAt: Date.now() }
    return res.json({ member })
  }
  if (!unknownEmailInvitesAllowed())
    return res.status(404).json({ error: 'no doop account with that email — ask them to sign up first' })
  const invite = await createInvite(ws.id, email, role, req.user!.id)
  if (mailerConfigured) {
    sendMail({
      to: email,
      subject: `${req.user!.name} invited you to "${ws.name}" on doop`,
      text: `${req.user!.name} invited you to the "${ws.name}" workspace on doop.\n\nCreate an account with this email address and you'll be in:\n\n${ORIGIN}/\n`,
    }).catch((err) => console.error('[workspaces] invite email failed', err))
  }
  const pending: WorkspaceInvite = {
    id: invite.id,
    email,
    role,
    invitedByName: req.user!.name,
    createdAt: invite.createdAt,
  }
  res.json({ invite: pending, emailed: mailerConfigured })
})

workspacesRouter.patch('/:id/members/:userId', (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  const role = req.body?.role
  if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: 'role must be admin or member' })
  if (req.params.userId === ws.ownerId) return res.status(400).json({ error: 'the owner keeps the owner role' })
  if (!setRole(ws.id, req.params.userId, role)) return res.status(404).json({ error: 'not a member' })
  res.json({ ok: true })
})

workspacesRouter.delete('/:id/members/:userId', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id)
  if (!ws) return
  const target = req.params.userId
  const self = target === req.user!.id
  if (!self && !hasRole(ws.id, req.user!.id, 'admin'))
    return res.status(403).json({ error: 'only workspace admins can remove people' })
  if (target === ws.ownerId)
    return res
      .status(400)
      .json({ error: self ? 'delete the workspace instead of leaving it' : 'the owner cannot be removed' })
  try {
    if (!(await removeMember(ws.id, target))) return res.status(404).json({ error: 'not a member' })
  } catch (err) {
    console.error('[workspaces] remove member failed', err)
    return res.status(500).json({ error: 'could not remove the member' })
  }
  res.json({ ok: true })
})

workspacesRouter.delete('/:id/invites/:inviteId', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  await db
    .delete(t.workspaceInvites)
    .where(and(eq(t.workspaceInvites.workspaceId, ws.id), eq(t.workspaceInvites.id, req.params.inviteId)))
  res.json({ ok: true })
})

/* ---- billing: hosted Stripe pages, and the mirror ---- */

/* The owner pays: the Stripe customer is theirs, and only they can start or
   manage a subscription. Admins run the people list; the bill is not theirs
   to move under their own name. */
workspacesRouter.post('/:id/billing/checkout', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'owner')
  if (!ws) return
  if (!billing.billingEnabled()) return res.status(400).json({ error: 'billing is not configured on this server' })
  const interval = req.body?.interval
  if (!isBillingInterval(interval)) return res.status(400).json({ error: 'interval must be month or year' })
  /* one subscription per workspace: a second checkout would bill twice
     while only the last one is on file */
  if (ws.stripeSubscriptionId && isWorkspaceActive(ws.status))
    return res.status(409).json({ error: 'this workspace already has a plan — change it from the billing portal' })
  try {
    const customerId = await billing.ensureCustomer(ws, req.user!.email)
    setCustomer(ws.id, customerId)
    const seats = members.get(ws.id)?.size ?? 1
    const url = await billing.createCheckout({ ...ws, stripeCustomerId: customerId }, interval, seats)
    res.json({ url })
  } catch (err) {
    console.error('[billing] checkout failed', err)
    res.status(502).json({ error: err instanceof Error ? err.message : 'could not start checkout' })
  }
})

workspacesRouter.post('/:id/billing/portal', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'owner')
  if (!ws) return
  if (!billing.billingEnabled()) return res.status(400).json({ error: 'billing is not configured on this server' })
  if (!ws.stripeCustomerId) return res.status(400).json({ error: 'no billing account yet — choose a plan first' })
  try {
    res.json({ url: await billing.createPortal({ ...ws, stripeCustomerId: ws.stripeCustomerId }) })
  } catch (err) {
    console.error('[billing] portal failed', err)
    res.status(502).json({ error: 'could not open the billing portal' })
  }
})

/* The browser is back from Checkout: pull the subscription now rather than
   wait for the webhook, so the workspace unlocks on the page they land on. */
workspacesRouter.post('/:id/billing/sync', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  if (!billing.billingEnabled()) return res.json(summaryFor(ws, req.user!.id))
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined
  try {
    const patch = await billing.fetchSubscription(ws, sessionId)
    if (patch) {
      const result = await applySubscription(ws.id, patch)
      if (result?.applied && isActive(ws)) await acceptPendingInvitesFor(ws)
    }
    res.json(summaryFor(ws, req.user!.id))
  } catch (err) {
    console.error('[billing] sync failed', err)
    res.status(502).json({ error: 'could not read the subscription from Stripe' })
  }
})

/** Stripe → workspace row. Mounted outside the session gate in index.ts with
 *  the raw body (signatures are over the exact bytes). */
export async function handleStripeWebhook(req: express.Request, res: express.Response): Promise<void> {
  if (!billing.webhookConfigured()) {
    res.status(501).json({ error: 'webhook not configured' })
    return
  }
  let event
  try {
    event = billing.parseWebhook(req.body as Buffer, req.header('stripe-signature'))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'bad signature' })
    return
  }
  try {
    const found = await billing.subscriptionFromEvent(event)
    if (found) {
      const result = await applySubscription(found.workspaceId, found.patch)
      if (result?.applied) {
        const { ws } = result
        console.log(`[billing] ${event.type}: workspace ${ws.id} → ${ws.status} (${ws.seats} seats)`)
        if (isActive(ws)) await acceptPendingInvitesFor(ws)
      } else if (result) {
        console.log(`[billing] ${event.type}: stale for workspace ${result.ws.id} — ignored`)
      }
    }
    res.json({ received: true })
  } catch (err) {
    /* a 5xx makes Stripe retry, which is what we want for a transient failure */
    console.error('[billing] webhook failed', err)
    res.status(500).json({ error: 'webhook handling failed' })
  }
}
