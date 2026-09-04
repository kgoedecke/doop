import { pgTable, text, doublePrecision, bigint, boolean, integer, index, primaryKey } from 'drizzle-orm/pg-core'

/**
 * One Postgres-dialect schema for every environment: PGlite (embedded, file
 * in ./data) during development, a managed Postgres via DATABASE_URL in
 * production. Timestamps are epoch-ms bigints to match the in-memory types.
 * No FK constraints — memory is the source of truth and writes are async
 * fire-and-forget, so we don't want ordering between them to matter.
 */

export const canvases = pgTable('canvases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id'),
  /** 'edit' | 'none'; null = 'none' (private — link sharing is opt-in) */
  linkAccess: text('link_access'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/** Users invited to collaborate on a canvas (the owner is not listed).
 *  Access = owner ∪ members ∪ (everyone, when link_access = 'edit'). */
export const canvasMembers = pgTable(
  'canvas_members',
  {
    canvasId: text('canvas_id').notNull(),
    userId: text('user_id').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.userId] })],
)

export const frames = pgTable(
  'frames',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    html: text('html').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    /** product-made onboarding/example content; null = a real user frame */
    demo: boolean('demo'),
  },
  (t) => [index('frames_canvas_idx').on(t.canvasId)],
)

/** Design-sync keys: the write-only capability behind the /ingest endpoint.
 *  An app embeds the doop-sync snippet with a key's secret, and its live
 *  screens land on ONE canvas as frames — the secret grants no reads and no
 *  other writes, so shipping it in an internal app's bundle is safe. `id` is
 *  the public handle (stamped into synced frame HTML to match page → frame);
 *  the secret never appears in canvas content. Cold path: read per ingest
 *  request, no in-memory mirror. Revocation = row deletion. */
export const syncKeys = pgTable(
  'sync_keys',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    canvasId: text('canvas_id').notNull(),
    /** label shown in the share modal and used as the frames' actor name */
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => [index('sync_keys_canvas_idx').on(t.canvasId), index('sync_keys_secret_idx').on(t.secret)],
)

/** Link hotspots a synced page declares: where each same-app link sits in the
 *  snapshot and which page it leads to. Replaced wholesale on every capture
 *  of that page — the set mirrors the CURRENT design, it is not history. */
export const syncLinks = pgTable(
  'sync_links',
  {
    keyId: text('key_id').notNull(),
    page: text('page').notNull(),
    toPage: text('to_page').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    label: text('label'),
  },
  (t) => [index('sync_links_page_idx').on(t.keyId, t.page)],
)

/** Navigations users actually made in the synced app, accumulated per route
 *  pair — the traffic weights on top of the declared link map. */
export const syncEdges = pgTable(
  'sync_edges',
  {
    keyId: text('key_id').notNull(),
    fromPage: text('from_page').notNull(),
    toPage: text('to_page').notNull(),
    count: integer('count').notNull().default(0),
    lastAt: bigint('last_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.fromPage, t.toPage] })],
)

/** A GitHub repo connected to a canvas as an import source. Two credential
 *  modes: a GitHub App installation (`installationId` set, short-lived
 *  tokens minted per call — the preferred flow) or a fine-grained PAT
 *  (`token` set — the paste-a-token fallback). Either way credentials stay
 *  server-side; API responses carry connection metadata only. Revocation =
 *  row deletion (plus uninstalling the app / revoking the PAT on GitHub).
 *  Frames imported through a connection carry a marker meta in their HTML
 *  (see server/github.ts), same provenance pattern as design-sync frames —
 *  no frame column. */
export const githubConnections = pgTable(
  'github_connections',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    /** "owner/name" */
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    token: text('token'),
    installationId: text('installation_id'),
    /** live deployment of this repo; enables the capture lane */
    deployUrl: text('deploy_url'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSyncedAt: bigint('last_synced_at', { mode: 'number' }),
  },
  (t) => [index('github_connections_canvas_idx').on(t.canvasId)],
)

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    agentName: text('agent_name').notNull(),
    owner: text('owner'),
    color: text('color').notNull(),
    status: text('status').notNull(),
    brief: text('brief'),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    endedAt: bigint('ended_at', { mode: 'number' }),
    auto: boolean('auto').notNull().default(false),
    queuedBy: text('queued_by'),
    claimedAt: bigint('claimed_at', { mode: 'number' }),
    failedAt: bigint('failed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
    /** comma-joined agent-role ids; null for status tasks and legacy cards */
    pipeline: text('pipeline'),
    stage: integer('stage'),
    /** comma-joined reference-frame ids uploaded with the prompt */
    attachments: text('attachments'),
    /** account id of the human who queued the card — picks the model credential */
    queuedByUserId: text('queued_by_user_id'),
    /** structured cards ('sketch', 'design-system'); null for prompt cards */
    kind: text('kind'),
    /** JSON payload of a structured card — what its runner needs, never a secret */
    payload: text('payload'),
  },
  (t) => [index('tasks_canvas_idx').on(t.canvasId)],
)

export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    canvasId: text('canvas_id').notNull(),
    agentName: text('agent_name').notNull(),
    targetAgent: text('target_agent'),
    fromName: text('from_name').notNull(),
    fromUserId: text('from_user_id'),
    text: text('text').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    deliveredAt: bigint('delivered_at', { mode: 'number' }),
    claimedBy: text('claimed_by'),
    completedAt: bigint('completed_at', { mode: 'number' }),
    failedAt: bigint('failed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
  },
  (t) => [index('feedback_canvas_idx').on(t.canvasId)],
)

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    frameId: text('frame_id').notNull(),
    selector: text('selector').notNull(),
    snippet: text('snippet').notNull(),
    fromName: text('from_name').notNull(),
    fromUserId: text('from_user_id'),
    text: text('text').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    forAgent: boolean('for_agent').notNull().default(false),
    targetAgent: text('target_agent'),
    claimedBy: text('claimed_by'),
    claimedAt: bigint('claimed_at', { mode: 'number' }),
    failedAt: bigint('failed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
    resolvedBy: text('resolved_by'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
    parentId: text('parent_id'),
  },
  (t) => [index('comments_canvas_idx').on(t.canvasId)],
)

/** Uploaded image assets: metadata only — bytes live in object storage (or
 *  ./data/assets in dev). canvas_id is a housekeeping hint, not ownership:
 *  liveness comes from asset_refs, so a URL copied to another canvas keeps
 *  its asset alive. */
export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id'),
    ownerId: text('owner_id'),
    mime: text('mime').notNull(),
    ext: text('ext').notNull(),
    size: integer('size').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('assets_canvas_idx').on(t.canvasId)],
)

/** Which frames reference which assets — a projection of frame HTML, synced
 *  on every durable frame write (recomputed from the frame's full HTML, so
 *  it cannot drift like a counter would) and rebuilt at boot. GC is then an
 *  indexed anti-join here instead of a scan over all HTML. */
export const assetRefs = pgTable(
  'asset_refs',
  {
    assetId: text('asset_id').notNull(),
    frameId: text('frame_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.frameId] }), index('asset_refs_frame_idx').on(t.frameId)],
)

/** Named design docs per canvas (brand rules, style recipes) — markdown
 *  written mostly for agents. Small and cold-path; hydrated with the canvas. */
export const guidelines = pgTable(
  'guidelines',
  {
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    markdown: text('markdown').notNull(),
    /* pretty display name; null = show the slug */
    title: text('title'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    /* world position of the card on the canvas; null = auto-placed */
    x: doublePrecision('x'),
    y: doublePrecision('y'),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.name] })],
)

/** Append-only history of guideline docs: one snapshot per save, an empty
 *  markdown marks a deletion. Capped per doc at write time; read on demand
 *  (cold path — no in-memory mirror). */
export const guidelineVersions = pgTable(
  'guideline_versions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    markdown: text('markdown').notNull(),
    savedAt: bigint('saved_at', { mode: 'number' }).notNull(),
    savedBy: text('saved_by').notNull(),
  },
  (t) => [index('guideline_versions_doc_idx').on(t.canvasId, t.name)],
)

/** Frames pinned to Memory as style exemplars: the HTML is a snapshot taken
 *  at pin time, deliberately decoupled from the (mutable, deletable) frame. */
export const memoryReferences = pgTable(
  'memory_references',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    frameId: text('frame_id').notNull(),
    title: text('title').notNull(),
    html: text('html').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    pinnedBy: text('pinned_by').notNull(),
    pinnedAt: bigint('pinned_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('memory_references_canvas_idx').on(t.canvasId)],
)

/** Resolved design decisions captured from addressed feedback/comments —
 *  the distiller's raw material. */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    text: text('text').notNull(),
    summary: text('summary'),
    source: text('source').notNull(),
    frameId: text('frame_id'),
    fromName: text('from_name').notNull(),
    agentName: text('agent_name'),
    at: bigint('at', { mode: 'number' }).notNull(),
    distilledAt: bigint('distilled_at', { mode: 'number' }),
  },
  (t) => [index('decisions_canvas_idx').on(t.canvasId)],
)

/** Rule edits the distiller proposed; humans accept (→ guide) or dismiss. */
export const memoryProposals = pgTable(
  'memory_proposals',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    guideName: text('guide_name').notNull(),
    guideTitle: text('guide_title'),
    rule: text('rule').notNull(),
    rationale: text('rationale').notNull(),
    /** comma-joined decision ids */
    basedOn: text('based_on').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    resolvedBy: text('resolved_by'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
  },
  (t) => [index('memory_proposals_canvas_idx').on(t.canvasId)],
)

export const activity = pgTable(
  'activity',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    actorName: text('actor_name').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorColor: text('actor_color').notNull(),
    message: text('message').notNull(),
    frameId: text('frame_id'),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [index('activity_canvas_idx').on(t.canvasId)],
)

/* free-tier metering: how many resident-team tasks each user has initiated */
export const residentUsage = pgTable('resident_usage', {
  userId: text('user_id').primaryKey(),
  used: integer('used').notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/** A user's own model subscription, connected so the Doop Agent keeps running
 *  once their free tasks are gone. Today that is ChatGPT (OAuth against
 *  auth.openai.com, refreshed here) or a plain OpenAI API key — `kind` says
 *  which, and the token columns are empty for the key path. Secrets: these
 *  rows are as sensitive as a password, and never leave the server. */
export const modelAccounts = pgTable('model_accounts', {
  userId: text('user_id').primaryKey(),
  /** 'chatgpt' (subscription, OAuth) | 'openai-key' (pay-as-you-go API key) */
  kind: text('kind').notNull(),
  /** chatgpt: the ChatGPT account the tokens are scoped to */
  accountId: text('account_id'),
  /** display only — whose subscription this is, and which plan */
  email: text('email'),
  plan: text('plan'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  /** epoch ms the access token expires; refreshed ahead of this */
  expiresAt: bigint('expires_at', { mode: 'number' }),
  apiKey: text('api_key'),
  /** the model tier this user picked; null = the server default */
  model: text('model'),
  connectedAt: bigint('connected_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})
