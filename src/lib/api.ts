import type { ActivityItem, Canvas, CanvasMeta, Frame } from '../../shared/types'

export type HomeActivity = ActivityItem & { canvasId: string; canvasName: string }

export interface CanvasMember {
  userId: string
  name: string
  email: string
  owner: boolean
}

/** A write-only design-sync key: apps embed its secret in the doop-sync
 *  snippet to push their live screens onto this canvas. */
export interface SyncKeyInfo {
  id: string
  secret: string
  canvasId: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  /** synced frames currently on the canvas */
  frames: number
}

/** The flow map of a canvas's synced app(s): link hotspots between frames
 *  and how often users actually navigated each pair. */
export interface SyncFlow {
  links: {
    fromFrameId: string
    toFrameId: string
    x: number
    y: number
    width: number
    height: number
    label: string | null
  }[]
  edges: { fromFrameId: string; toFrameId: string; count: number; lastAt: number }[]
}

/** A GitHub repo connected as an import source. The server keeps the token;
 *  clients only ever see connection metadata. */
export interface GithubConnectionInfo {
  id: string
  canvasId: string
  repo: string
  branch: string
  createdAt: number
  lastSyncedAt: number | null
  /** how the connection authenticates: the GitHub App, or a pasted token */
  via: 'app' | 'token'
  /** frames on the canvas imported through this connection */
  frames: number
}

export interface InstallationRepo {
  fullName: string
  private: boolean
}

export interface RepoScreen {
  kind: 'page' | 'story' | 'component' | 'static'
  route: string
  sourcePath: string
  title: string
  dynamic: boolean
  /** where the pixels come from: repo HTML, or an outline placeholder */
  source: 'static' | 'placeholder'
}

export interface RepoManifest {
  connection: Omit<GithubConnectionInfo, 'frames'>
  framework: string | null
  screens: RepoScreen[]
  truncated: boolean
}

/** An import queues board cards — nothing lands on the canvas until the
 *  Doop Agent finishes each one. `rejected` lists selections the server no
 *  longer finds in the repo manifest. */
export interface GithubImportResult {
  cards: string[]
  rejected: string[]
}

export interface DiscoveredPage {
  url: string
  title: string
}

export interface DiscoveredSite {
  siteUrl: string
  pages: DiscoveredPage[]
  truncated: boolean
}

/** The Doop Agent's free-task meter for the signed-in user. */
export interface Allowance {
  used: number
  limit: number
  /** connected an agent of their own over MCP — unmetered */
  connected: boolean
  /** connected a model account the Doop Agent itself can run on */
  byoModel: boolean
  byoKind?: ModelAccountKind
  byoEmail?: string
  /** free tasks are spent and their own account is carrying the agent */
  onOwnAccount: boolean
}

export type ModelAccountKind = 'chatgpt' | 'openai-key'

/** An in-flight device sign-in: the user types `userCode` at `verificationUrl`
 *  and the server polls OpenAI until they approve. */
export interface DeviceFlow {
  userCode: string
  verificationUrl: string
  status: 'pending' | 'connected' | 'error'
  error?: string
}

export interface AgentModelOption {
  id: string
  name: string
  blurb: string
}

export interface ModelAccountStatus {
  connected: boolean
  kind?: ModelAccountKind
  email?: string
  plan?: string
  /** the model tier this account runs on right now */
  model?: string
  connectedAt?: number
  /** false when the server has switched the ChatGPT flow off */
  chatgptEnabled?: boolean
  /** the tiers a user may pick between */
  models?: AgentModelOption[]
}

export interface WebsiteImportResult {
  frames: Frame[]
  failures: { url: string; error: string }[]
}
import { getIdentity } from './identity'

function actor() {
  const { clientId, name } = getIdentity()
  return { clientId, name, kind: 'user' as const }
}

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, text: string) {
    super(`${status} ${text}`)
    this.status = status
    try {
      this.body = JSON.parse(text)
    } catch {
      this.body = {}
    }
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}

export const api = {
  listCanvases: () => req<CanvasMeta[]>('/api/canvases'),
  getCanvas: (id: string) => req<Canvas>(`/api/canvases/${id}`),
  deleteCanvas: (id: string) => req(`/api/canvases/${id}`, { method: 'DELETE' }),
  homeActivity: () => req<HomeActivity[]>('/api/home/activity'),
  createCanvas: (name: string) => req<Canvas>('/api/canvases', { method: 'POST', body: JSON.stringify({ name }) }),
  duplicateCanvas: (id: string) => req<Canvas>(`/api/canvases/${id}/duplicate`, { method: 'POST' }),
  claimCanvas: (id: string) => req(`/api/canvases/${id}/claim`, { method: 'POST' }),
  renameCanvas: (id: string, name: string) =>
    req('/api/canvases/' + id, { method: 'PATCH', body: JSON.stringify({ name, actor: actor() }) }),
  /* owner-only: what the share link grants people who aren't invited */
  setLinkAccess: (id: string, linkAccess: 'edit' | 'none') =>
    req('/api/canvases/' + id, { method: 'PATCH', body: JSON.stringify({ linkAccess }) }),
  /* collaborators: the owner plus invited members */
  listMembers: (canvasId: string) => req<CanvasMember[]>(`/api/canvases/${canvasId}/members`),
  inviteMember: (canvasId: string, email: string) =>
    req<CanvasMember>(`/api/canvases/${canvasId}/members`, { method: 'POST', body: JSON.stringify({ email }) }),
  removeMember: (canvasId: string, userId: string) =>
    req(`/api/canvases/${canvasId}/members/${userId}`, { method: 'DELETE' }),
  /* design-sync keys for the embeddable snippet */
  listSyncKeys: (canvasId: string) => req<SyncKeyInfo[]>(`/api/canvases/${canvasId}/sync-keys`),
  createSyncKey: (canvasId: string, name: string) =>
    req<SyncKeyInfo>(`/api/canvases/${canvasId}/sync-keys`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteSyncKey: (canvasId: string, keyId: string) =>
    req(`/api/canvases/${canvasId}/sync-keys/${keyId}`, { method: 'DELETE' }),
  syncFlow: (canvasId: string) => req<SyncFlow>(`/api/canvases/${canvasId}/sync-flow`),
  /* GitHub repos connected as import sources */
  listGithubConnections: (canvasId: string) => req<GithubConnectionInfo[]>(`/api/canvases/${canvasId}/github`),
  connectGithub: (canvasId: string, input: { repo: string; token?: string; pass?: string; branch?: string }) =>
    req<GithubConnectionInfo>(`/api/canvases/${canvasId}/github`, { method: 'POST', body: JSON.stringify(input) }),
  githubAppInfo: () => req<{ enabled: boolean; slug: string }>('/api/github/app'),
  startGithubInstall: (canvasId: string) =>
    req<{ url: string }>(`/api/canvases/${canvasId}/github/app/start`, { method: 'POST' }),
  listInstallationRepos: (canvasId: string, pass: string) =>
    req<InstallationRepo[]>(`/api/canvases/${canvasId}/github/app/repos?pass=${encodeURIComponent(pass)}`),
  deleteGithubConnection: (canvasId: string, connId: string) =>
    req(`/api/canvases/${canvasId}/github/${connId}`, { method: 'DELETE' }),
  analyzeGithub: (canvasId: string, connId: string) =>
    req<RepoManifest>(`/api/canvases/${canvasId}/github/${connId}/analyze`, { method: 'POST' }),
  importGithubScreens: (canvasId: string, connId: string, screens: RepoScreen[], designSystem = true) =>
    req<GithubImportResult>(`/api/canvases/${canvasId}/github/${connId}/import`, {
      method: 'POST',
      body: JSON.stringify({ screens, design_system: designSystem }),
    }),
  guidelineHistory: (canvasId: string, name: string) =>
    req<{ markdown: string; savedAt: number; savedBy: string }[]>(
      `/api/canvases/${canvasId}/guidelines/${encodeURIComponent(name)}/history`,
    ),
  /* empty markdown deletes the guide; title is the pretty display name */
  setGuideline: (canvasId: string, name: string, markdown: string, title?: string) =>
    req(`/api/canvases/${canvasId}/guidelines/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ markdown, ...(title !== undefined ? { title } : {}) }),
    }),
  /* design memory */
  pinReference: (canvasId: string, frameId: string) =>
    req(`/api/canvases/${canvasId}/references`, { method: 'POST', body: JSON.stringify({ frameId }) }),
  unpinReference: (canvasId: string, refId: string) =>
    req(`/api/canvases/${canvasId}/references/${refId}`, { method: 'DELETE' }),
  resolveProposal: (canvasId: string, proposalId: string, accept: boolean) =>
    req(`/api/canvases/${canvasId}/proposals/${proposalId}`, { method: 'POST', body: JSON.stringify({ accept }) }),
  /* raw image bytes -> permanent /a/ URL (5 MB cap, type sniffed server-side) */
  uploadAsset: async (canvasId: string, blob: Blob) => {
    const res = await fetch(`/api/canvases/${canvasId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    if (!res.ok) {
      if (res.status === 413) throw new Error('image exceeds the 5 MB limit')
      const text = await res.text()
      let msg = `${res.status} ${text}`
      try {
        msg = JSON.parse(text).error || msg
      } catch {
        /* non-JSON error body */
      }
      throw new Error(msg)
    }
    return res.json() as Promise<{ url: string; mime: string; size: number }>
  },
  createFrame: (canvasId: string, input: Partial<Frame> & { name: string }) =>
    req<Frame>(`/api/canvases/${canvasId}/frames`, {
      method: 'POST',
      body: JSON.stringify({ ...input, actor: actor() }),
    }),
  updateFrame: (frameId: string, patch: Partial<Frame>) =>
    req<Frame>('/api/frames/' + frameId, { method: 'PATCH', body: JSON.stringify({ ...patch, actor: actor() }) }),
  deleteFrame: (frameId: string) =>
    req('/api/frames/' + frameId, { method: 'DELETE', body: JSON.stringify({ actor: actor() }) }),
  sendTaskFeedback: (taskId: string, text: string) =>
    req(`/api/tasks/${taskId}/feedback`, { method: 'POST', body: JSON.stringify({ text, from: getIdentity().name }) }),
  importPage: (canvasId: string, url: string) =>
    req<Frame>(`/api/canvases/${canvasId}/import`, { method: 'POST', body: JSON.stringify({ url }) }),
  discoverSitePages: (canvasId: string, url: string) =>
    req<DiscoveredSite>(`/api/canvases/${canvasId}/import/discover`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  importSitePages: (canvasId: string, urls: string[]) =>
    req<WebsiteImportResult>(`/api/canvases/${canvasId}/import`, {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),
  agentAllowance: () => req<Allowance>('/api/agent-allowance'),
  modelAccount: () => req<ModelAccountStatus>('/api/model-account'),
  chatgptAuthorize: () =>
    req<{ url: string; state: string; catching: boolean }>('/api/model-account/chatgpt/authorize', { method: 'POST' }),
  startDeviceAuth: () => req<DeviceFlow>('/api/model-account/chatgpt/device', { method: 'POST' }),
  deviceAuthStatus: () => req<DeviceFlow | { status: 'none' }>('/api/model-account/chatgpt/device'),
  cancelDeviceAuth: () => req('/api/model-account/chatgpt/device', { method: 'DELETE' }),
  connectChatgpt: (redirect: string) =>
    req<ModelAccountStatus>('/api/model-account/chatgpt', { method: 'POST', body: JSON.stringify({ redirect }) }),
  connectOpenAiKey: (apiKey: string) =>
    req<ModelAccountStatus>('/api/model-account/openai-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  disconnectModelAccount: () => req<ModelAccountStatus>('/api/model-account', { method: 'DELETE' }),
  setAgentModel: (model: string) =>
    req<ModelAccountStatus>('/api/model-account', { method: 'PATCH', body: JSON.stringify({ model }) }),
  addCard: (canvasId: string, title: string, agents: string[], attachments?: string[]) =>
    req(`/api/canvases/${canvasId}/cards`, { method: 'POST', body: JSON.stringify({ title, agents, attachments }) }),
  completeCard: (canvasId: string, cardId: string) =>
    req(`/api/canvases/${canvasId}/cards/${cardId}/done`, { method: 'POST' }),
  retryCard: (canvasId: string, cardId: string) =>
    req(`/api/canvases/${canvasId}/cards/${cardId}/retry`, { method: 'POST' }),
  addComment: (frameId: string, input: { selector: string; snippet: string; text: string }) =>
    req(`/api/frames/${frameId}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  replyComment: (commentId: string, text: string) =>
    req(`/api/comments/${commentId}/replies`, { method: 'POST', body: JSON.stringify({ text }) }),
  resolveComment: (commentId: string) => req(`/api/comments/${commentId}/resolve`, { method: 'POST' }),
  retryComment: (commentId: string) => req(`/api/comments/${commentId}/retry`, { method: 'POST' }),
  retryTaskFeedback: (feedbackId: string) => req(`/api/feedback/${feedbackId}/retry`, { method: 'POST' }),
}

export interface AdminCanvas extends CanvasMeta {
  linkAccess: 'edit' | 'none'
  memberCount: number
  owner?: { id: string; name: string; email: string }
}

export interface AdminUser {
  id: string
  name: string
  email: string
  role: string | null
  banned: boolean | null
  createdAt: number
  canvasCount: number
}

/** Instance-admin surface. Every route 404s for non-admins, so a failure here
 *  is indistinguishable from the feature not existing — which is the point. */
export const adminApi = {
  canvases: () => req<{ total: number; canvases: AdminCanvas[] }>('/api/admin/canvases'),
  stats: () => req<{ users: number; canvases: number; frames: number }>('/api/admin/stats'),
  users: () => req<AdminUser[]>('/api/admin/users'),

  /* better-auth's own endpoints, not ours: they swap the session cookie, so
     every caller reloads afterwards rather than trying to reconcile state. */
  impersonate: (userId: string) =>
    req('/api/auth/admin/impersonate-user', { method: 'POST', body: JSON.stringify({ userId }) }),
  stopImpersonating: () => req('/api/auth/admin/stop-impersonating', { method: 'POST' }),

  /* also better-auth's: banning revokes the user's sessions and blocks
     sign-in; the server refuses their MCP tokens separately */
  ban: (userId: string, banReason?: string) =>
    req('/api/auth/admin/ban-user', { method: 'POST', body: JSON.stringify({ userId, banReason }) }),
  unban: (userId: string) => req('/api/auth/admin/unban-user', { method: 'POST', body: JSON.stringify({ userId }) }),
}
