import { env } from './env.ts'
import type { Canvas } from '../shared/types.ts'

export interface CompanyBinding {
  readonly workspaceId: string
  readonly botUserId: string
}

export class CompanyPolicyError extends Error {
  constructor() {
    super('Managed company workspace policy denies this operation or configuration')
    this.name = 'CompanyPolicyError'
  }
}

interface SetupFacts {
  users: readonly { id: string; role: string | null }[]
  workspaces: readonly { id: string; ownerId: string }[]
  memberships: readonly { workspaceId: string; userId: string; role: string }[]
  canvases: readonly Canvas[]
}

function bindingsFrom(value: string): readonly CompanyBinding[] {
  if (Buffer.byteLength(value) > 65_536) throw new CompanyPolicyError()
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new CompanyPolicyError()
  }
  if (!Array.isArray(decoded) || decoded.length > 128) throw new CompanyPolicyError()
  const workspaces = new Set<string>()
  const bots = new Set<string>()
  const id = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate)
  return Object.freeze(
    decoded.map((entry: unknown) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new CompanyPolicyError()
      if (Object.keys(entry).sort().join(',') !== 'botUserId,workspaceId') throw new CompanyPolicyError()
      const binding = entry as Record<string, unknown>
      if (!id(binding.workspaceId) || !id(binding.botUserId)) throw new CompanyPolicyError()
      if (workspaces.has(binding.workspaceId) || bots.has(binding.botUserId)) throw new CompanyPolicyError()
      workspaces.add(binding.workspaceId)
      bots.add(binding.botUserId)
      return Object.freeze({ workspaceId: binding.workspaceId, botUserId: binding.botUserId })
    }),
  )
}

/** Fixed operator policy. Ordinary account/workspace owners cannot change it. */
export class CompanyPolicy {
  readonly bindings: readonly CompanyBinding[]
  private readonly bots: ReadonlyMap<string, string>
  private readonly spaces: ReadonlySet<string>

  constructor(configuration: string) {
    this.bindings = bindingsFrom(configuration)
    this.bots = new Map(this.bindings.map((binding) => [binding.botUserId, binding.workspaceId]))
    this.spaces = new Set(this.bindings.map((binding) => binding.workspaceId))
  }

  workspaceFor(userId: string | undefined): string | undefined {
    return userId ? this.bots.get(userId) : undefined
  }

  isPrivate(workspaceId: string | undefined): boolean {
    return workspaceId !== undefined && this.spaces.has(workspaceId)
  }

  allowsDestination(userId: string | undefined, workspaceId: string | undefined): boolean {
    const bound = this.workspaceFor(userId)
    return bound === undefined || bound === workspaceId
  }

  assertCreation(ownerId: string | undefined, workspaceId: string | undefined): void {
    if (!this.allowsDestination(ownerId, workspaceId) || (this.isPrivate(workspaceId) && !ownerId)) {
      throw new CompanyPolicyError()
    }
  }

  assertWorkspaceOwner(userId: string): void {
    if (this.workspaceFor(userId) !== undefined) throw new CompanyPolicyError()
  }

  allowsMembership(workspaceId: string, userId: string, role: string): boolean {
    const bound = this.workspaceFor(userId)
    return bound === undefined || (bound === workspaceId && role === 'member')
  }

  assertInvite(canvas: Canvas, userId: string): void {
    if (!this.allowsDestination(userId, canvas.workspaceId)) throw new CompanyPolicyError()
  }

  assertMove(canvas: Canvas, workspaceId: string | undefined): void {
    this.assertCreation(canvas.ownerId, workspaceId)
    if (this.isPrivate(canvas.workspaceId) && canvas.workspaceId !== workspaceId) throw new CompanyPolicyError()
    if (
      this.isPrivate(workspaceId) &&
      ((canvas.linkAccess && canvas.linkAccess !== 'none') || canvas.publishedAt !== undefined)
    ) {
      throw new CompanyPolicyError()
    }
  }

  assertPublicFeature(workspaceId: string | undefined): void {
    if (this.isPrivate(workspaceId)) throw new CompanyPolicyError()
  }

  allowsListing(userId: string, canvas: Canvas, workspaceIds: readonly string[]): boolean {
    return (
      this.allowsDestination(userId, canvas.workspaceId) &&
      (!this.isPrivate(canvas.workspaceId) || workspaceIds.includes(canvas.workspaceId!))
    )
  }

  validate(facts: SetupFacts): void {
    const users = new Map(facts.users.map((user) => [user.id, user]))
    const spaces = new Set(facts.workspaces.map((workspace) => workspace.id))
    for (const binding of this.bindings) {
      const user = users.get(binding.botUserId)
      if (!user || user.role === 'admin' || !spaces.has(binding.workspaceId)) throw new CompanyPolicyError()
    }
    for (const workspace of facts.workspaces) this.assertWorkspaceOwner(workspace.ownerId)
    for (const membership of facts.memberships) {
      if (!this.allowsMembership(membership.workspaceId, membership.userId, membership.role))
        throw new CompanyPolicyError()
    }
    for (const canvas of facts.canvases) {
      this.assertCreation(canvas.ownerId, canvas.workspaceId)
      for (const member of canvas.memberIds ?? []) this.assertInvite(canvas, member)
      if (
        this.isPrivate(canvas.workspaceId) &&
        ((canvas.linkAccess && canvas.linkAccess !== 'none') || canvas.publishedAt !== undefined)
      ) {
        throw new CompanyPolicyError()
      }
    }
  }
}

export const companyPolicy = new CompanyPolicy(env.MANAGED_COMPANY_WORKSPACES)
