import { canEditCanvas, hasDurableCanvasAccess } from './access.ts'
import { store } from './store.ts'
import { companyPolicy } from './companyPolicy.ts'
import { getWorkspace, isActive, isWorkspaceMember } from './workspaces.ts'
import { isBanned } from './auth.ts'
import { createHash } from 'node:crypto'
import type { Frame } from '../shared/types.ts'
import { RenderBusyError } from './renderAdmission.ts'
import { PrivateMaterializationError } from '../shared/privateMedia.ts'

/** Resource identity and display attribution never grant canvas rights. */
export class PrivateResourceError extends Error {
  constructor() {
    super('private resource is not available')
  }
}

/** Long file operations revalidate the same authenticated account before commit. */
export async function requireResourceActor(actorId: string, reader?: Parameters<typeof isBanned>[1]): Promise<void> {
  if (await isBanned(actorId, reader)) throw new PrivateResourceError()
}

/** Initial parents and explicit copies use the existing live creation policy. */
export function requireCanvasCreation(actorId: string | undefined, workspaceId: string | undefined): void {
  companyPolicy.assertCreation(actorId, workspaceId)
  if (workspaceId) {
    const workspace = getWorkspace(workspaceId)
    if (!actorId || !workspace || !isWorkspaceMember(workspaceId, actorId) || !isActive(workspace))
      throw new PrivateResourceError()
  }
}

export function privateCanvas(canvasId: string, actorId: string | undefined, access: 'read' | 'edit' = 'read') {
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !hasDurableCanvasAccess(actorId, canvas)) return undefined
  return access === 'edit' && !canEditCanvas(actorId, canvas) ? undefined : canvas
}

export function requirePrivateCanvas(canvasId: string, actorId: string, access: 'read' | 'edit' = 'edit') {
  const canvas = privateCanvas(canvasId, actorId, access)
  if (!canvas) throw new PrivateResourceError()
  return canvas
}

/** Ephemeral authority from normal auth. Never persist or forward its credentials. */
export interface ResourceReader {
  readonly actorId: string
  readonly currentActor: () => Promise<string | undefined>
}

export interface CanvasReadScope {
  readonly reader: ResourceReader
  readonly canvasId: string
}

export type PrivateRenderScope = CanvasReadScope &
  (
    | {
        readonly kind: 'frame'
        readonly frameId: string
        readonly selection?: readonly Readonly<Pick<Frame, 'id' | 'canvasId'>>[]
      }
    | { readonly kind: 'reference'; readonly referenceId: string }
  )

export function jobResourceReader(actorId: string | undefined): ResourceReader {
  if (!actorId) throw new PrivateResourceError()
  return Object.freeze({
    actorId,
    currentActor: async () => {
      await requireResourceActor(actorId)
      return actorId
    },
  })
}

export async function requireReadActor(reader: ResourceReader): Promise<void> {
  try {
    if (!reader?.actorId || (await reader.currentActor()) !== reader.actorId) throw new PrivateResourceError()
    await requireResourceActor(reader.actorId)
  } catch (error) {
    throw resourceReadError(error)
  }
}

export async function assertCanvasRead(scope: CanvasReadScope): Promise<void> {
  if (!scope) throw new PrivateResourceError()
  await requireReadActor(scope.reader)
  if (!privateCanvas(scope.canvasId, scope.reader.actorId)) throw new PrivateResourceError()
}

export function frameReadScope(
  reader: ResourceReader,
  frame: Pick<Frame, 'id' | 'canvasId'>,
  selected?: readonly Frame[],
): PrivateRenderScope {
  const selection = selected
    ? Object.freeze(selected.map(({ id, canvasId }) => Object.freeze({ id, canvasId })))
    : undefined
  return Object.freeze({ reader, canvasId: frame.canvasId, kind: 'frame', frameId: frame.id, selection })
}

export function referenceReadScope(reader: ResourceReader, canvasId: string, referenceId: string): PrivateRenderScope {
  return Object.freeze({ reader, canvasId, kind: 'reference', referenceId })
}

/** A detached content snapshot cannot stand in for a deleted resource. */
export async function assertRenderRead(scope: PrivateRenderScope, snapshot?: Frame): Promise<void> {
  await assertCanvasRead(scope)
  if (snapshot && snapshot.canvasId !== scope.canvasId) throw new PrivateResourceError()
  if (scope.kind === 'frame') {
    const live = store.getFrame(scope.frameId)
    if (!live || live.canvasId !== scope.canvasId || (snapshot && snapshot.id !== scope.frameId))
      throw new PrivateResourceError()
    for (const selected of scope.selection ?? []) {
      const current = store.getFrame(selected.id)
      if (selected.canvasId !== scope.canvasId || !current || current.canvasId !== scope.canvasId)
        throw new PrivateResourceError()
    }
  } else if (scope.kind === 'reference') {
    const live = store.getReferences(scope.canvasId).find((ref) => ref.id === scope.referenceId)
    if (!live || (snapshot && snapshot.id !== `reference-${scope.referenceId}`)) throw new PrivateResourceError()
  } else {
    throw new PrivateResourceError()
  }
}

/** Content, rather than clock resolution, identifies a rendered snapshot. */
export function frameContentKey(frame: Pick<Frame, 'id' | 'canvasId' | 'html' | 'width' | 'height'>): string {
  return createHash('sha256')
    .update(JSON.stringify([frame.canvasId, frame.id, frame.html, frame.width, frame.height]))
    .digest('hex')
}

export const MAX_PRIVATE_RENDER_BYTES = 15_000_000

export class PrivateRenderLimitError extends Error {
  constructor() {
    super('private render exceeds the output budget')
  }
}

export function assertPrivateRenderBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_PRIVATE_RENDER_BYTES) throw new PrivateRenderLimitError()
}

export class PrivateReadUnavailableError extends Error {
  constructor() {
    super('private read is temporarily unavailable')
  }
}

/** Job readers share these owners too; do not pass driver URLs/SQL or frame diagnostics downstream. */
export function resourceReadError(error: unknown): Error {
  return error instanceof PrivateResourceError ||
    error instanceof PrivateReadUnavailableError ||
    error instanceof PrivateRenderLimitError ||
    error instanceof PrivateMaterializationError ||
    error instanceof RenderBusyError
    ? error
    : new PrivateReadUnavailableError()
}

/** PDF selection is one stored canvas; losing any selected identity denies the whole artifact. */
export async function assertFramesRead(reader: ResourceReader, frames: readonly Frame[]): Promise<void> {
  const canvasId = frames[0]?.canvasId
  if (!canvasId) throw new PrivateResourceError()
  await assertCanvasRead({ reader, canvasId })
  for (const frame of frames) {
    const live = store.getFrame(frame.id)
    if (frame.canvasId !== canvasId || !live || live.canvasId !== canvasId) throw new PrivateResourceError()
  }
}
