import type Anthropic from '@anthropic-ai/sdk'
import { store } from './store.ts'
import { ModelAuthError, pickModel } from './agentModel.ts'
import { RESIDENT_TASK_LIMIT } from './allowance.ts'
import * as actions from './actions.ts'
import { inspectFrame, renderFrame } from './screenshot.ts'
import { AGENT_ROLES, DEFAULT_ROLE_ID, roleById, roleByAgentName, roleName } from '../shared/agents.ts'
import type { AgentRole } from '../shared/agents.ts'
import * as imageSearch from './imageSearch.ts'
import * as ingest from './ingest.ts'
import { viewWebsite, referencedUrls } from './website.ts'
import { createImportedWebpageFrame, findImportedWebpageFrame } from './webpageImport.ts'
import { DESIGN_BRIEF, DESIGN_QUALITY } from './guide.ts'
import { getStyleRecipe } from './recipes.ts'
import { describeInspiration, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import type { Frame } from '../shared/types.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { executeGuardedBatch } from './guardedBatch.ts'
import { runRepoCards } from './githubRecon.ts'

/**
 * The resident design team: a server-side Claude tool loop, run once per
 * agent role that has work waiting. Doop builds; the specialists (UX, copy,
 * brand, accessibility, polish) each own one pass. A board card names an
 * ordered pipeline of roles and moves down it one stage at a time, so a
 * single card can go design → copy → brand → a11y without a human in between.
 *
 * Everything each agent does flows through the same actions the MCP tools
 * use, so users see the full show: presence, set_status in the working-now
 * strip, a task in the panel, and edits playing back through the reveal.
 *
 * Which model each run uses is server/agentModel.ts's decision: the server
 * tier (Anthropic by default, or an Azure OpenAI deployment via
 * DOOP_AGENT_PROVIDER) covers the free tasks, and past that the run moves onto
 * the model account the requesting human connected (their ChatGPT
 * subscription or OpenAI key). With neither, the queue behaves as it always
 * did — the work waits for the next agent to connect over MCP.
 */

const MAX_TURNS = 24
/* a redesign card delivers an audit doc plus TWO draft frames in one run */
const MAX_REDESIGN_TURNS = 40
/* a sweep hands a card down its pipeline in place; the cap is a backstop
   against a card that somehow keeps requeueing itself */
const MAX_SWEEP_RUNS = 24
const LARGE_HTML_CHARS = 60_000
const MAX_HTML_READ_CHARS = 30_000
const MAX_REWRITE_CHUNK_CHARS = 12_000
const MAX_REWRITE_CHARS = 100_000

/* one run per canvas at a time; feedback arriving mid-run queues a re-run */
const running = new Set<string>()
const queued = new Set<string>()

export function onFeedback(canvasId: string) {
  if (running.has(canvasId)) {
    queued.add(canvasId)
    return
  }
  sweep(canvasId).catch((err) => console.error('[resident] sweep failed', err))
}

/** Work every agent that has something waiting, one at a time. Re-checking the
 *  queue between runs is what carries a card into its next pipeline stage. */
async function sweep(canvasId: string) {
  running.add(canvasId)
  /* Requesters with no usable model right now. A run bills one person, so
     without this a requester who cannot pay would be re-picked forever and
     block everyone queued behind them. */
  const stalled = new Set<string>()
  /* Agents whose whole queue is stalled. Skipped rather than breaking the
     sweep, so one unpayable queue cannot hide another agent's runnable work. */
  const idle = new Set<string>()
  try {
    for (let i = 0; i < MAX_SWEEP_RUNS; i++) {
      const next = actions.pendingWorkAgents(canvasId).find((name) => !idle.has(name))
      if (!next) break
      const outcome = await runAgent(canvasId, next, stalled)
      if (outcome === 'idle') {
        idle.add(next)
        continue
      }
      /* a completed run can hand a card down its pipeline, which may put
         payable work in front of an agent that had nothing a moment ago */
      idle.clear()
    }
  } finally {
    running.delete(canvasId)
    if (queued.delete(canvasId)) onFeedback(canvasId)
  }
}

const SYSTEM = `You are a resident design agent of the Doop canvas — a multiplayer design tool where humans and AI agents design HTML frames together. You live in the server and your job is narrow: when work lands on the canvas for you, you do it, promptly and well.

Rules:
- Only make the changes the request asks for, and only the ones your specialty covers. No refactors, no redesigns beyond the request, no new frames unless asked.
- Queued cards are standalone work requests from the board. A card may be routed through several agents in turn — you own your stage of it and nothing else. If your specialty is to originate work: a new-asset card means create_frame sized for the job, a change request means editing the existing frame. One card, one deliverable.
- Later stages inherit whatever earlier stages left. Read the frame as it is now; never undo a previous agent's work because you would have done it differently.
- Resolve frame references against the numbered frame list in the request. A literal frame name wins; otherwise "Frame 1" means the first listed frame, and "the other frame" means the only remaining frame when there are two.
- Choose a size-aware strategy. For documents over 60,000 characters, call inspect_frame before reading HTML. Use get_frame_html with a query or bounded range only when markup is needed.
- For requests to copy, match, or borrow another frame's design: screenshot and inspect BOTH the target and reference before editing. Use the reference screenshot and computed design tokens as the source of visual truth. Read target HTML only when you need to preserve its content; do not load a large reference document just to learn its style. For a full redesign, use begin_frame_rewrite, append_frame_rewrite in chunks under 12,000 characters, and commit_frame_rewrite; then screenshot the changed frame.
- Element comments are pinned to ONE element (you get its CSS selector and an HTML excerpt). Change that element or its immediate context — never rework unrelated parts of the frame because of an element comment.
- Frames are complete HTML documents with inline CSS. Keep each frame's existing style and structure; change what the feedback requires.
- Prefer edit_frame_html (exact find/replace) for small changes; use set_frame_html only when the change is structural.
- After any visual change, call screenshot_frame and LOOK at the result. If it doesn't clearly satisfy the feedback, fix it before finishing.
- Call set_status when you start ("Fixing: …") and when your focus shifts. One line, under 80 chars, present tense. People watch this live.
- Never leave a frame worse than you found it.
- Reference sites: when a request names a site or URL — a redesign of it, or "like acme.com" — call import_webpage with as_reference=true FIRST so an editable HTML snapshot lands on the canvas, then call screenshot_frame on that imported source and design from what is actually there: its real copy, nav labels, product facts, and imagery direction. Leave the imported source unchanged and deliver your work in a separate frame. If importing or editing the snapshot itself is the requested deliverable, use as_reference=false. view_website is read-only; use it only when you need to inspect a live page without adding it to the canvas. A redesign that invents content is wrong even when it looks good. If automated access is blocked and there is no existing source frame or attached screenshot, stop and ask the user to attach screenshots; never approximate the site from guesses.
- Real imagery: when a design calls for photography, use search_images (you see thumbnails — pick the one whose mood and palette fit) and embed its image_url with object-fit: cover and a real alt text. For UI icons use search_icons and hotlink the SVG URL; for company logos (customer walls, integration rows, press bars) use search_logos. Never fake a photo with a gray box or a made-up URL; if search is unavailable, draw the visual as inline SVG/CSS.
- If a request is unclear or impossible (missing frame, contradictory ask), do the closest reasonable thing and say what you did in your final message.
- Your final message should be one or two sentences: what you changed and where.

Design quality — the bar for anything you originate or restyle (canvas guidelines and pinned style references outrank it; a frame you are only editing keeps its established direction):
${DESIGN_QUALITY}

Design brief — when your card asks you to ORIGINATE new design work:
${DESIGN_BRIEF}`

/** The system prompt for one agent: the shared harness rules plus its specialty. */
function systemFor(role: AgentRole): string {
  const reviewer = role.reviewer
    ? '\n\nYou are a review pass. Judge what is already on the canvas against your specialty and fix only what fails it. Changing nothing is a valid outcome — if the frame already meets your bar, say so plainly in your final message instead of inventing work.'
    : ''
  return `${SYSTEM}\n\n---\n\nYour role on this canvas is ${role.name}. ${role.brief}${reviewer}\n\nStay inside that specialty. Anything outside it belongs to another agent on the team (${AGENT_ROLES.filter(
    (r) => r.id !== role.id,
  )
    .map((r) => `${r.name}: ${r.blurb.toLowerCase()}`)
    .join('; ')}) — leave it to them rather than fixing it yourself.`
}

interface FeedbackItem {
  from: string
  text: string
  about: string
}

interface RunState {
  mutatedFrames: Set<string>
  sourceFrames: Set<string>
  verificationFrames: Set<string>
  verifiedFrames: Set<string>
  rewriteDrafts: Map<string, string>
  blockedWebsiteAccess?: string
}

function deliverableFrameIds(runState: RunState): string[] {
  return [...runState.mutatedFrames].filter((id) => !runState.sourceFrames.has(id))
}

function verificationFrameIds(runState: RunState): string[] {
  return [...new Set([...runState.mutatedFrames, ...runState.verificationFrames])]
}

function completeHtml(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const html = value.trim()
  if (html.length < 80 || !/<html(?:\s|>)/i.test(html) || !/<\/html>\s*$/i.test(html)) return undefined
  return html
}

const REDESIGN_RE =
  /\b(redesign|re-?style|same style|match (?:the )?(?:style|design)|copy (?:the )?(?:style|design)|design of)\b/i

function strategyFor(text: string, frames: NonNullable<ReturnType<typeof store.getCanvas>>['frames']): string {
  const isRedesign = REDESIGN_RE.test(text)
  const redesignNote = isRedesign
    ? ' For the redesign itself, work audit-first and deliver TWO drafts:' +
      ' (1) Audit the source — inspect_frame on a source frame for its computed palette, type, spacing, radii and shadows (import_webpage first for a live site), plus a screenshot for layout.' +
      ' (2) Persist the audit with set_guidelines as a doc named "redesign-<source>" (e.g. "redesign-pipefile-com"): a "Source baseline" recording the old system (palette hexes, type, spacing/radii, and the section map — each section\'s purpose and one-line message) as a descriptive record of what you are redesigning away from, NOT rules to follow; then two binding directions. "Direction A — closer to home": the brand stays recognizable — logo, name, core brand colors (re-weighted freely, with new neutrals and tints) — while every detail is redesigned: typography, spacing rhythm, radii, shadows, patterns, background treatments, button and component styling, section layout. "Direction B — further out": same product, same real copy and facts, but freer — reinterpret the palette and push the aesthetic somewhere genuinely different; do not invent it from vibes — retrieve category inspiration (get_style_recipe for the closest recipe, search_inspiration for live exemplars), adapt it, and name it in the redesign doc.' +
      ' (3) Deliver TWO new frames side by side, named "<source> — A (on-brand)" and "<source> — B (departure)", each executing its direction precisely; screenshot both. Both frames together are this card\'s deliverable. In both: keep the source\'s real copy and product facts, restructure sections when it strengthens the page\'s argument, and give details a genuinely new treatment rather than reordering the old elements.' +
      ' Exception: if the request already fixes the scope ("keep it subtle", "same style", "go wild", "rebrand"), deliver ONE draft at that scope instead.' +
      ' If your canvas guidelines already include a redesign doc for this source, skip (1)-(2) and follow its directions.'
    : ''
  const large = frames.filter((frame) => frame.html.length > LARGE_HTML_CHARS)
  if (large.length === 0)
    return 'Standard HTML strategy: inspect visually, read the relevant source, edit, and verify.' + redesignNote

  if (isRedesign && frames.length > 1) {
    return (
      `Large cross-frame redesign strategy (${large.map((frame) => frame.name).join(', ')} exceed ${LARGE_HTML_CHARS} HTML characters): ` +
      'screenshot and inspect the target and reference; use visible content plus computed design tokens; do not read the reference HTML; build replacement HTML atomically with begin_frame_rewrite, append_frame_rewrite chunks, and commit_frame_rewrite; screenshot the changed target.' +
      redesignNote
    )
  }
  return (
    `Large targeted-edit strategy (${large.map((frame) => frame.name).join(', ')} exceed ${LARGE_HTML_CHARS} HTML characters): ` +
    'inspect the relevant frame, use get_frame_html with query or a bounded range, apply the smallest exact edit, and screenshot the changed frame.' +
    redesignNote
  )
}

type RunOutcome = 'ran' | 'idle' | 'no-model'

/**
 * Work one requester's queue for one agent. A run bills exactly one person:
 * the account behind the oldest claimable item, resolved BEFORE anything is
 * claimed so a server with no model at all leaves the queue untouched.
 */
async function runAgent(canvasId: string, agentName: string, stalled: Set<string>): Promise<RunOutcome> {
  const role = roleByAgentName(agentName) ?? roleById(DEFAULT_ROLE_ID)!
  const payer = actions.nextWorkPayer(canvasId, role.name, stalled)
  if (payer === undefined) return 'idle'
  /* Only work that predates per-user attribution falls back to the canvas
     owner — a real requester never bills a collaborator or the owner. */
  const canvasOwner = store.getCanvas(canvasId)?.ownerId
  const model = await pickModel(payer || canvasOwner)
  if (!model) {
    stalled.add(payer)
    return 'no-model'
  }
  /* With no free tier, the server's key never pays for resident work. Work
     can still reach this point without a payable account — queued before the
     account was disconnected, or before metering tightened — and it must
     fail visibly with a fix, not crash on a key that was never meant to pay. */
  if (!model.userId && RESIDENT_TASK_LIMIT <= 0) {
    const reason =
      'The Doop Agent needs a connected account — connect your ChatGPT subscription or OpenAI key in Settings, then retry.'
    for (const f of actions.takeFeedbackFor(canvasId, role.name, payer)) actions.failTaskFeedback(f.id, reason)
    for (const c of actions.takeAgentCommentsFor(canvasId, role.name, payer)) actions.failComment(c.id, reason)
    for (const c of actions.takeQueuedCardsFor(canvasId, role.name, payer)) actions.failCard(canvasId, c.id, reason)
    stalled.add(payer)
    return 'no-model'
  }
  const actor = actions.resolveActor({ name: role.name, kind: 'agent' })

  /* claim this agent's open work — the UI flips to "picked up" instantly.
     Claiming happens before the try so an agent with nothing to do never
     shows up in presence. */
  const claimed = actions.takeFeedbackFor(canvasId, role.name, payer)
  const comments = actions.takeAgentCommentsFor(canvasId, role.name, payer)
  const allCards = actions.takeQueuedCardsFor(canvasId, role.name, payer)
  if (claimed.length === 0 && comments.length === 0 && allCards.length === 0) {
    /* nothing actually claimable for this payer — do not re-pick them */
    stalled.add(payer)
    return 'no-model'
  }
  /* structured repo cards (the GitHub import) have their own runner with
     repo-reading tools; only prompt cards go through the chat loop below */
  const repoCards = allCards.filter((c) => c.kind)
  const cards = allCards.filter((c) => !c.kind)

  /* presence otherwise only refreshes on tool activity, and the sweep's TTL
     is shorter than a big generation turn */
  const heartbeat = setInterval(() => actions.heartbeatAgent(canvasId, actor), 15_000)

  if (repoCards.length > 0) {
    try {
      await runRepoCards(canvasId, repoCards, model, actor)
    } catch (err) {
      /* the runner fails cards one by one; this is the backstop for a
         failure outside any card, so none stays claimed forever */
      console.error('[resident] repo cards errored', err)
      for (const c of repoCards)
        actions.failCard(canvasId, c.id, 'Doop hit a snag before finishing. Retry when you are ready.')
    }
    if (claimed.length === 0 && comments.length === 0 && cards.length === 0) {
      clearInterval(heartbeat)
      actions.setAgentStatus(canvasId, actor, '')
      return 'ran'
    }
  }

  try {
    const tasks = actions.getTasks(canvasId)
    const items: FeedbackItem[] = claimed.map((f) => ({
      from: f.from,
      text: f.text,
      about: tasks.find((t) => t.id === f.taskId)?.status ?? 'a task on this canvas',
    }))

    actions.setAgentStatus(
      canvasId,
      actor,
      items.length + comments.length > 0 ? 'Reading feedback…' : 'Picking up a card…',
    )

    const canvas = store.getCanvas(canvasId)
    /* demo frames (the Doop welcome show, seeded examples) are product
       content, not user work — hidden so agents never mistake them for
       the canvas's established style */
    const visibleFrames = (canvas?.frames ?? []).filter((f) => !f.demo)
    const frameList = visibleFrames
      .map(
        (f, index) =>
          `- Frame ${index + 1}: id=${f.id}, name="${f.name}", ${Math.round(f.width)}x${Math.round(f.height)} (last edit: ${f.updatedBy}, ${f.html.length} bytes${f.html.length > LARGE_HTML_CHARS ? '; large document — avoid a full read for visual-reference work' : ''})`,
      )
      .join('\n')

    const sections: string[] = []
    /* design-synced canvases: real navigation between the synced screens is
       redesign-critical context — heavy paths must stay prominent */
    const flowLines = canvas ? ingest.describeSyncFlow(await ingest.getSyncFlow(canvas), visibleFrames) : []
    if (flowLines.length > 0) {
      sections.push(
        `How this app's screens connect (from live design sync — navigation counts are real users):\n` +
          flowLines.map((line) => `- ${line}`).join('\n') +
          `\nRespect this when redesigning: do not bury or weaken elements that carry heavy navigation.`,
      )
    }
    if (items.length > 0) {
      sections.push(
        `New human feedback on this canvas:\n` +
          items.map((i) => `- ${i.from} (about the work "${i.about}"): "${i.text}"`).join('\n'),
      )
    }
    if (cards.length > 0) {
      sections.push(
        `Queued cards — work requests humans left on the board for you:\n` +
          cards
            .map((c) => {
              const pipeline = actions.pipelineOf(c)
              const stage = Math.min(c.stage ?? 0, pipeline.length - 1)
              const route =
                pipeline.length > 1
                  ? ` [stage ${stage + 1} of ${pipeline.length}: ${pipeline.map(roleName).join(' → ')}` +
                    (stage > 0 ? `; earlier stages have already run — build on what they left]` : `]`)
                  : ''
              const attached = (c.attachments ?? [])
                .map((id) => {
                  const f = store.getFrame(id)
                  return f ? `${f.id} ("${f.name}")` : null
                })
                .filter(Boolean)
              const refs =
                attached.length > 0
                  ? `\n  Attached reference images, already on the canvas as frames: ${attached.join(', ')}. ` +
                    `Call screenshot_frame on each BEFORE designing and build from what you see. ` +
                    `They are source material — leave them as they are and deliver in a separate frame.`
                  : ''
              return `- from ${c.queuedBy}: "${c.brief ?? c.status}"${route}${refs}`
            })
            .join('\n'),
      )
    }
    if (comments.length > 0) {
      sections.push(
        `New element comments addressed to you (each is pinned to a specific element):\n` +
          comments
            .map((c) => {
              const fname = store.getFrame(c.frameId)?.name ?? 'unknown frame'
              /* a reply carries the conversation it answers, so "make it
                 bigger" reads against what was said before */
              const history = actions.commentThread(c)
              const earlier = history
                .slice(
                  0,
                  history.findIndex((x) => x.id === c.id),
                )
                .map((x) => `    ${x.from}: "${x.text}"`)
                .join('\n')
              const thread = earlier ? `\n  earlier in this thread:\n${earlier}` : ''
              return `- ${c.from} on frame ${c.frameId} "${fname}", element ${c.selector}\n  element HTML at comment time: ${c.snippet}${thread}\n  comment: "${c.text}"`
            })
            .join('\n'),
      )
    }
    const workText = [
      ...items.map((item) => item.text),
      ...cards.map((card) => card.brief ?? card.status),
      ...comments.map((comment) => comment.text),
    ].join('\n')
    const urls = referencedUrls(workText)
    const references = store.getReferences(canvasId)
    const referenceList =
      references.length > 0
        ? `\n\nPinned style references — designs humans marked "more like this"; they are the ground truth for this canvas's look:\n` +
          references
            .map(
              (r) =>
                `- ${r.id}: "${r.title}" (${Math.round(r.width)}x${Math.round(r.height)}, pinned by ${r.pinnedBy})`,
            )
            .join('\n') +
          `\nBefore designing or restyling anything, call get_reference on the most relevant one and match its palette, typography and spacing.`
        : ''
    const kickoff =
      sections.join('\n\n') +
      `\n\nFrames currently on the canvas:\n${frameList}` +
      referenceList +
      `\n\nExecution strategy selected by the harness:\n${strategyFor(workText, visibleFrames)}` +
      (urls.length > 0
        ? `\n\nThe request references ${urls.join(', ')} — if each page is source material for a separate design, call import_webpage with as_reference=true BEFORE designing so an editable HTML snapshot lands on the canvas for everyone to compare against. Then call screenshot_frame on each imported source, leave those source frames unchanged, and build from their real content and structure. If the imported snapshot itself is the requested deliverable, call it with as_reference=false instead. view_website is read-only and does not add anything to the canvas.`
        : '') +
      `\n\nAddress everything above now.` +
      (comments.length > 0
        ? ` For element comments, use the selector and HTML excerpt to find the exact element in the frame's HTML — the live document may have drifted since the comment was left, so match on content, not position.`
        : '')

    console.log(
      `[resident] run start canvas=${canvasId} agent=${role.name} model=${model.label}${model.userId ? ` on=${model.userId}` : ''} feedback=${claimed.length} comments=${comments.length} cards=${cards.length}`,
    )
    /* a review pass legitimately ends without touching a frame; an
       originating pass that changed nothing has not delivered its card */
    const requireMutation = cards.length > 0 && !role.reviewer
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: kickoff }]
    const runState: RunState = {
      mutatedFrames: new Set(),
      sourceFrames: new Set(),
      verificationFrames: new Set(),
      verifiedFrames: new Set(),
      rewriteDrafts: new Map(),
    }
    let refused = false
    let crashed = false
    let staleAccount = false
    let finished = false
    let mutationNudgeSent = false
    let verificationNudgeSent = false
    let outputLimitNudgeSent = false
    let turnsUsed = 0

    try {
      /* canvas design docs ride as a second system block with their own cache
         breakpoint: the role prefix stays cacheable across canvases, and the
         (rarely-changing) docs cache across the turns of a run */
      const guidelineDocs = store.getGuidelines(canvasId)
      const guidelinesBlock = guidelineDocs.length
        ? [
            {
              text:
                `# Canvas design guidelines\nEvery frame on this canvas must follow these docs — they outrank your own aesthetic preferences:\n\n` +
                guidelineDocs.map((d) => `## ${d.name}\n\n${d.markdown}`).join('\n\n'),
              cache: true,
            },
          ]
        : []
      const maxTurns = REDESIGN_RE.test(workText) ? MAX_REDESIGN_TURNS : MAX_TURNS
      for (let turn = 0; turn < maxTurns; turn++) {
        const res = await model.run({
          maxTokens: 16000,
          system: [{ text: systemFor(role), cache: true }, ...guidelinesBlock],
          tools: TOOLS,
          messages,
        })

        if (res.stop_reason === 'refusal') {
          actions.setAgentStatus(canvasId, actor, "Couldn't address that feedback")
          refused = true
          break
        }

        messages.push({ role: 'assistant', content: res.content })
        turnsUsed = turn + 1
        const toolBlocks = res.content.filter(
          (block): block is Anthropic.ToolUseBlockParam => block.type === 'tool_use',
        )
        console.log(
          `[resident] response canvas=${canvasId} turn=${turnsUsed} stop=${res.stop_reason} tools=${toolBlocks.map((block) => block.name).join(',') || 'none'}`,
        )

        /* A response can contain a complete tool_use block even when its stop
         reason is max_tokens. The Messages protocol still requires an
         immediate tool_result for every emitted tool id, so content blocks —
         not stop_reason — are authoritative for tool execution. */
        if (toolBlocks.length > 0) {
          /* Models may emit an import and design mutations in one parallel
             batch. Run imports first and defer every other call to the next
             turn, when the model can inspect the imported source. If access is
             blocked, skip the whole remainder. Results retain protocol order. */
          const importInBatch = toolBlocks.some((block) => block.name === 'import_webpage')
          let importFailureInBatch: string | undefined
          const results = await executeGuardedBatch<Anthropic.ToolUseBlockParam, Anthropic.ToolResultBlockParam>(
            toolBlocks,
            {
              priority: (block) => (block.name === 'import_webpage' ? 1 : 0),
              blocked: (block) =>
                runState.blockedWebsiteAccess ??
                importFailureInBatch ??
                (importInBatch && block.name !== 'import_webpage'
                  ? 'The website import must be inspected before any design changes. Continue on the next turn by calling screenshot_frame on the imported source.'
                  : undefined),
              skipped: (block, reason) => ({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Skipped ${block.name}. ${reason}`,
                is_error: true,
              }),
              execute: async (block) => {
                const target = (block.input as Record<string, unknown>).frame_id
                console.log(
                  `[resident] tool canvas=${canvasId} name=${block.name}${typeof target === 'string' ? ` frame=${target}` : ''}`,
                )
                const result = await execTool(block, canvasId, actor, runState)
                if (block.name === 'import_webpage' && result.is_error && !runState.blockedWebsiteAccess) {
                  importFailureInBatch =
                    'The website import failed. Correct the tool error and retry the import before making design changes.'
                }
                return result
              },
            },
          )
          messages.push({ role: 'user', content: results })
          continue
        }

        if (runState.blockedWebsiteAccess) {
          finished = true
          break
        }

        if (res.stop_reason === 'max_tokens' && !outputLimitNudgeSent) {
          outputLimitNudgeSent = true
          messages.push({
            role: 'user',
            content:
              'Your response reached the output limit before producing an executable edit. Continue with bounded tool calls: begin_frame_rewrite, append_frame_rewrite with each chunk under 12,000 characters, then commit_frame_rewrite and screenshot_frame.',
          })
          continue
        }

        if (requireMutation && deliverableFrameIds(runState).length === 0 && !mutationNudgeSent) {
          mutationNudgeSent = true
          messages.push({
            role: 'user',
            content:
              'You have not changed or created a deliverable frame yet, so the queued design card is not complete. Imported source frames are reference material and do not count as the deliverable. Make the requested visual change now. For a full redesign, use begin_frame_rewrite, append_frame_rewrite chunks under 12,000 characters, and commit_frame_rewrite, then verify it with screenshot_frame.',
          })
          continue
        }
        const unverified = verificationFrameIds(runState).filter((id) => !runState.verifiedFrames.has(id))
        if (cards.length > 0 && unverified.length > 0 && !verificationNudgeSent) {
          verificationNudgeSent = true
          messages.push({
            role: 'user',
            content: `You have not visually verified ${unverified.join(', ')}. Call screenshot_frame for each frame, inspect the render, and fix any problems before finishing.`,
          })
          continue
        }
        finished = true
        break
      }
    } catch (err) {
      /* An API/tool crash becomes a visible, manually retryable failure. */
      crashed = true
      /* a dead credential is the one crash a human can actually fix, so it
         gets its own wording all the way through to the card — but only when
         the credential is theirs: a server-tier run has no account to
         reconnect, whatever error class its transport leaks */
      staleAccount = err instanceof ModelAuthError && !!model.userId
      console.error('[resident] run errored', err)
      actions.setAgentStatus(
        canvasId,
        actor,
        staleAccount ? 'Your model connection expired — reconnect it' : 'Hit a snag — waiting for a retry',
      )
    }

    /* only a NATURALLY finished run completes its work — refused, crashed,
       or out-of-turns runs pause so nothing gets a false Done or auto-retry */
    const deliverableFrames = deliverableFrameIds(runState)
    const blockedWebsiteAccess = runState.blockedWebsiteAccess
    const noMutation = finished && requireMutation && deliverableFrames.length === 0 && !blockedWebsiteAccess
    const unverifiedMutation =
      finished &&
      !blockedWebsiteAccess &&
      cards.length > 0 &&
      verificationFrameIds(runState).some((id) => !runState.verifiedFrames.has(id))
    const exhausted = !finished && !refused && !crashed
    if (exhausted) actions.setAgentStatus(canvasId, actor, 'Ran out of turns — waiting for a retry')
    if (blockedWebsiteAccess && !staleAccount) {
      actions.setAgentStatus(canvasId, actor, 'Website blocked — needs screenshots')
    }
    if (noMutation) actions.setAgentStatus(canvasId, actor, 'No frame changed — waiting for a retry')
    if (unverifiedMutation) actions.setAgentStatus(canvasId, actor, 'Change not verified — waiting for a retry')
    console.log(
      `[resident] run end canvas=${canvasId} agent=${role.name} turns=${turnsUsed} finished=${finished} refused=${refused} crashed=${crashed} mutations=${runState.mutatedFrames.size} sources=${runState.sourceFrames.size} deliverables=${deliverableFrames.length} verified=${runState.verifiedFrames.size}`,
    )
    if (finished) {
      /* The closing summary remains useful when a no-op card is returned to
         the queue: it tells the human why no deliverable was accepted. */
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
        const text = last.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
        console.log(`[resident] summary canvas=${canvasId} ${text.replace(/\s+/g, ' ').trim().slice(0, 500)}`)
        actions.agentSummary(canvasId, actor, text)
      }
    }
    if (finished && !blockedWebsiteAccess && !noMutation && !unverifiedMutation) {
      for (const f of claimed) actions.completeTaskFeedback(f.id)
      for (const c of comments) actions.resolveComment(c.id, role.name)
      /* a card moves to the next agent in its pipeline, or finishes here */
      for (const c of cards) actions.advanceCard(canvasId, c.id, actor)
    } else {
      let reason: string
      if (staleAccount) {
        reason = `${model.label} turned down the connected account. Reconnect it in Doop, then retry.${blockedWebsiteAccess ? ` ${blockedWebsiteAccess}` : ''}`
      } else if (blockedWebsiteAccess) {
        reason = blockedWebsiteAccess
      } else if (refused) {
        reason = `${role.name} could not take this request. Retry when you are ready.`
      } else if (crashed) {
        reason = `${role.name} hit a snag before finishing. Retry when you are ready.`
      } else if (exhausted) {
        reason = `${role.name} ran out of turns before finishing. Retry when you are ready.`
      } else if (noMutation) {
        reason = `${role.name} finished without changing a frame. Retry when you are ready.`
      } else {
        reason = `${role.name} changed a frame but could not verify it. Retry when you are ready.`
      }
      for (const f of claimed) actions.failTaskFeedback(f.id, reason)
      for (const c of comments) actions.failComment(c.id, reason)
      for (const c of cards) actions.failCard(canvasId, c.id, reason)
    }
  } finally {
    clearInterval(heartbeat)
    /* clear the status — this completes the agent's task in the panel */
    actions.setAgentStatus(canvasId, actor, '')
  }
  return 'ran'
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'set_status',
    description:
      'Broadcast a one-line "what I am doing right now" to everyone watching the canvas. Call it when you start and whenever your focus shifts.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Present tense, under 80 chars' } },
      required: ['status'],
    },
  },
  {
    name: 'create_frame',
    description:
      'Add a new frame to the canvas — use this when a queued card asks for a new design rather than a change to an existing frame. Streams in live for viewers.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        width: { type: 'number', description: 'px, e.g. 1200' },
        height: { type: 'number', description: 'px, e.g. 630' },
        html: { type: 'string', description: 'Complete HTML document with inline CSS' },
      },
      required: ['name', 'width', 'height', 'html'],
    },
  },
  {
    name: 'inspect_frame',
    description:
      'Inspect the rendered page without relying on class names. Returns a compact semantic element outline, visible text, geometry, computed colors, typography, radii, shadows, and CSS variables. Use this before working with large frames and for cross-frame visual references.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'get_frame_html',
    description:
      "Read a bounded portion of a frame's source HTML before a targeted edit. Use query to retrieve small snippets around matching text, or offset/limit to page through source. For full visual redesigns, prefer inspect_frame plus screenshots and replace the target with compact standalone HTML.",
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        query: {
          type: 'string',
          description: 'Optional literal text to find in the HTML; returns bounded context around up to five matches',
        },
        offset: { type: 'number', description: 'Character offset for a bounded source read; defaults to 0' },
        limit: { type: 'number', description: 'Characters to return; defaults to 20000 and is capped at 30000' },
      },
      required: ['frame_id'],
    },
  },
  {
    name: 'edit_frame_html',
    description:
      'Exact find/replace in a frame\'s HTML — the change morphs into the live render. Use for small, targeted changes. "find" must occur exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
      },
      required: ['frame_id', 'find', 'replace'],
    },
  },
  {
    name: 'set_frame_html',
    description:
      'Replace a frame with a complete compact HTML document in one call. Use only when the entire html argument is under 12,000 characters; use the staged rewrite tools for larger documents.',
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        html: { type: 'string', description: 'Complete HTML document with inline CSS' },
      },
      required: ['frame_id', 'html'],
    },
  },
  {
    name: 'begin_frame_rewrite',
    description:
      'Start an atomic full-frame rewrite. This creates an empty server-side draft and does not change the live frame. Follow with one or more append_frame_rewrite calls, then commit_frame_rewrite.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'append_frame_rewrite',
    description:
      'Append one bounded chunk to an atomic frame rewrite draft. Keep each chunk under 12,000 characters. The live frame is unchanged until commit_frame_rewrite succeeds.',
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        chunk: { type: 'string', description: 'The next exact HTML chunk, under 12,000 characters' },
      },
      required: ['frame_id', 'chunk'],
    },
  },
  {
    name: 'commit_frame_rewrite',
    description:
      'Validate and atomically apply the accumulated rewrite draft to the live frame. Fails without changing the frame if the draft is empty or not a complete HTML document.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'search_images',
    description:
      'Search free stock photography and get candidate photos WITH visual thumbnails — look at them and pick the one that fits the frame. Use concrete, scene-level queries ("team collaborating loft office", not "business"). Embed the chosen image_url directly in frame HTML with object-fit: cover and a real alt text.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Scene-level description of the photo you want' },
        orientation: {
          type: 'string',
          enum: ['landscape', 'portrait', 'square'],
          description: 'Match the slot the photo will fill',
        },
        count: { type: 'number', description: 'Candidates to return, 1-8, default 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_icons',
    description:
      'Search 200,000+ open-source UI icons, returned as hotlinkable SVG URLs. Search the concept ("shopping cart", "arrow right"). Results are semantically named ids — pick by name. For company logos use search_logos instead.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Icon concept, e.g. "shopping cart"' },
        limit: { type: 'number', description: 'Max results, default 24' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_logos',
    description:
      'Find a company\'s logo by brand name or domain — returns the company\'s real mark as a hotlinkable URL (thumbnail included when possible), plus open-source vector marks for well-known brands. The exact domain ("acme.io") resolves far more reliably than a name. Use for customer-logo walls, integration rows, testimonial cards, press bars. Favicon-sourced logos are small rasters — display at 32px or less, never scale up.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company name or domain' },
        count: { type: 'number', description: 'Candidates to return, 1-8, default 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'view_website',
    description:
      'Read-only inspection of a public web page: acquires its current HTML and returns a locally rendered desktop screenshot plus visible text without changing the canvas. Use import_webpage instead when the page needs to land on the canvas as an editable HTML snapshot.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page URL — a bare domain like "acme.io" is loaded over https' },
      },
      required: ['url'],
    },
  },
  {
    name: 'import_webpage',
    description:
      'Import one public web page onto the current canvas as an editable HTML snapshot. Scripts and iframes are removed and stylesheets are inlined. Set as_reference=true when it is source material for a separate design; matching reference snapshots are reused across pipeline stages. Set false when importing or editing the snapshot itself is the deliverable; this creates a fresh deliverable copy. Call screenshot_frame on the returned frame.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page URL — a bare domain like "acme.io" is loaded over https' },
        as_reference: {
          type: 'boolean',
          description:
            'True for source material that must remain unchanged; false when the imported snapshot itself is the deliverable',
        },
      },
      required: ['url', 'as_reference'],
    },
  },
  {
    name: 'get_reference',
    description:
      'Read a pinned style reference — a design a human marked "more like this" — as a rendered screenshot plus its HTML. References are listed in your request when the canvas has them. Match the reference\'s palette, typography and spacing in what you design.',
    input_schema: {
      type: 'object',
      properties: {
        reference_id: { type: 'string', description: 'Reference id from the pinned-references list in your request' },
      },
      required: ['reference_id'],
    },
  },
  {
    name: 'get_style_recipe',
    description:
      'Fetch one of the built-in style recipes — complete, executable style directions (mood north star, palette with roles, type pairing, signature moves) distilled from real gallery exemplars. The design-brief ritual in your instructions lists the menu; fetch the closest match for your category before writing a brief, then ADAPT it to the brand rather than copying it verbatim.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Recipe slug from the menu in your instructions' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_inspiration',
    description:
      'Search a curated gallery of real, well-designed live websites by category and SEE thumbnails with pre-distilled style facts (one-line mood north star, named palette, fonts). Use it while writing a design brief — especially for landing pages — when no built-in recipe fits the category, or alongside one: query the category plus the page type ("law firm landing page", "dark fintech dashboard"). Adapt what you see into the brief and name the exemplars; never embed these screenshots or copy an identity.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Category + page type, e.g. "grocery delivery landing page"' },
        count: { type: 'number', description: 'Exemplars to return, default 4, max 6' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_decision',
    description:
      'Persist a design decision to the canvas Memory so humans and later agents see what was committed to — this is how you post your design brief (mood, recipe adapted, palette roles, type). Keep it under 500 chars. Design taste only, never one-off content edits.',
    input_schema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          description:
            'The decision, e.g. "Brief: candlelit mood via oatside-soft-shelf — cream ground, caramel accent, Fraunces/Nunito Sans"',
        },
      },
      required: ['decision'],
    },
  },
  {
    name: 'set_guidelines',
    description:
      "Create, replace or delete a named style guide on this canvas (markdown, max 24,000 chars; empty string deletes). Write rules other designers and agents can execute directly: palette hexes, font families, spacing/radius/shadow conventions, layout recipes, do/don't lists. Also how you persist a redesign audit (binding Direction + descriptive source baseline) so every later job inherits it.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Doc slug, e.g. "redesign-pipefile-com" (a-z, 0-9, hyphens)' },
        markdown: { type: 'string', description: 'Full replacement markdown for this doc; empty string deletes it' },
        title: {
          type: 'string',
          description:
            'Pretty display name shown to humans, e.g. "Pipefile design system"; omit to keep the current one',
        },
      },
      required: ['name', 'markdown'],
    },
  },
  {
    name: 'screenshot_frame',
    description:
      'Render a frame and SEE it as an image. Call this after every visual change to verify the feedback is actually addressed.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
]

/* tall frames (imported landing pages) are CROPPED to the top 4000px at full
   detail rather than downscaled to mush; width still scales down if it would
   breach the API's 8000px image limit */
const MAX_SHOT_HEIGHT = 4000

async function frameImageBlocks(
  f: Frame,
): Promise<NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>>> {
  const cropped = f.height > MAX_SHOT_HEIGHT
  const scale = Math.min(1, 7000 / f.width)
  const big = Math.max(f.width, Math.min(f.height, MAX_SHOT_HEIGHT)) * scale > 2000
  const buf = await renderFrame(f, scale, {
    maxHeight: MAX_SHOT_HEIGHT,
    ...(big ? { type: 'jpeg' as const, quality: 80 } : {}),
  })
  const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: big ? 'image/jpeg' : 'image/png',
        data: buf.toString('base64'),
      },
    },
  ]
  if (cropped) {
    blocks.push({
      type: 'text',
      text: `Note: this frame is ${Math.round(f.height)}px tall — the screenshot shows only the top ${MAX_SHOT_HEIGHT}px.`,
    })
  }
  return blocks
}

async function execTool(
  block: Anthropic.ToolUseBlockParam,
  canvasId: string,
  actor: ReturnType<typeof actions.resolveActor>,
  runState: RunState,
): Promise<Anthropic.ToolResultBlockParam> {
  const input = block.input as Record<string, string>
  const fail = (msg: string): Anthropic.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: msg,
    is_error: true,
  })
  const ok = (content: Anthropic.ToolResultBlockParam['content']): Anthropic.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content,
  })

  try {
    switch (block.name) {
      case 'set_status': {
        actions.setAgentStatus(canvasId, actor, String(input.status ?? ''))
        return ok('ok')
      }
      case 'create_frame': {
        const raw = block.input as { name?: string; width?: number; height?: number; html?: string }
        const html = completeHtml(raw.html)
        if (!html) return fail('create_frame requires a complete non-empty HTML document ending in </html>')
        if (html.length > MAX_REWRITE_CHUNK_CHARS) {
          return fail(`create_frame HTML must be compact (at most ${MAX_REWRITE_CHUNK_CHARS} characters)`)
        }
        const f = actions.createFrame(
          canvasId,
          {
            name: String(raw.name || 'Frame'),
            width: Number(raw.width) || 800,
            height: Number(raw.height) || 500,
            html,
          },
          actor,
        )
        if (!f) return fail('canvas not found')
        runState.mutatedFrames.add(f.id)
        runState.verifiedFrames.delete(f.id)
        return ok(
          `created frame ${f.id} ("${f.name}", ${Math.round(f.width)}x${Math.round(f.height)}) — it is revealing to viewers now`,
        )
      }
      case 'inspect_frame': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const inspection = await inspectFrame(f)
        return ok(JSON.stringify(inspection))
      }
      case 'get_frame_html': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        if (typeof f.html !== 'string') return fail('frame HTML is unavailable; retry after the frame reloads')
        const raw = block.input as { query?: string; offset?: number; limit?: number }
        const query = String(raw.query || '').trim()
        const limit = Math.max(1000, Math.min(Number(raw.limit) || 20_000, MAX_HTML_READ_CHARS))
        if (query) {
          const haystack = f.html.toLowerCase()
          const needle = query.toLowerCase()
          const matches: number[] = []
          let cursor = 0
          while (matches.length < 5) {
            const index = haystack.indexOf(needle, cursor)
            if (index < 0) break
            matches.push(index)
            cursor = index + Math.max(needle.length, 1)
          }
          if (matches.length === 0) return fail(`query not found in frame HTML: ${query}`)
          const perMatch = Math.max(1000, Math.floor(limit / matches.length))
          const snippets = matches.map((index, match) => {
            const start = Math.max(0, index - Math.floor(perMatch / 2))
            const end = Math.min(f.html.length, start + perMatch)
            return `--- match ${match + 1} at ${index}, chars ${start}-${end} ---\n${f.html.slice(start, end)}`
          })
          return ok(
            `Frame HTML: ${f.html.length} characters; ${matches.length} match(es) for "${query}".\n${snippets.join('\n')}`,
          )
        }
        const offset = Math.max(0, Math.min(Number(raw.offset) || 0, f.html.length))
        const end = Math.min(f.html.length, offset + limit)
        return ok(
          `Frame HTML: ${f.html.length} characters. Returning chars ${offset}-${end}.${end < f.html.length ? ` Continue with offset=${end}, or use query for a targeted snippet.` : ''}\n\n${f.html.slice(offset, end)}`,
        )
      }
      case 'edit_frame_html': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        if (typeof f.html !== 'string') return fail('frame HTML is unavailable; retry after the frame reloads')
        if (typeof input.find !== 'string' || !input.find) return fail('find must be a non-empty exact HTML string')
        if (typeof input.replace !== 'string') return fail('replace must be an HTML string')
        const count = f.html.split(input.find).length - 1
        if (count === 0) return fail('"find" text not found — call get_frame_html and copy the exact text')
        if (count > 1)
          return fail(`"find" text occurs ${count} times — include more surrounding context to make it unique`)
        actions.updateFrame(input.frame_id, { html: f.html.replace(input.find, input.replace) }, actor)
        runState.mutatedFrames.add(input.frame_id)
        runState.verifiedFrames.delete(input.frame_id)
        return ok('applied')
      }
      case 'set_frame_html': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const html = completeHtml(input.html)
        if (!html) {
          return fail(
            'set_frame_html did not receive a complete HTML document. If output was truncated, use begin_frame_rewrite, append_frame_rewrite chunks, and commit_frame_rewrite.',
          )
        }
        if (html.length > MAX_REWRITE_CHUNK_CHARS) {
          return fail(
            `set_frame_html is limited to ${MAX_REWRITE_CHUNK_CHARS} characters. Use begin_frame_rewrite, append_frame_rewrite chunks, and commit_frame_rewrite.`,
          )
        }
        actions.updateFrame(input.frame_id, { html }, actor)
        runState.mutatedFrames.add(input.frame_id)
        runState.verifiedFrames.delete(input.frame_id)
        return ok('applied — the new design is revealing to viewers now')
      }
      case 'begin_frame_rewrite': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        runState.rewriteDrafts.set(input.frame_id, '')
        return ok(
          `rewrite draft started for ${input.frame_id}; append chunks under ${MAX_REWRITE_CHUNK_CHARS} characters`,
        )
      }
      case 'append_frame_rewrite': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        if (!runState.rewriteDrafts.has(input.frame_id)) return fail('no rewrite draft; call begin_frame_rewrite first')
        const raw = block.input as { chunk?: unknown }
        if (typeof raw.chunk !== 'string' || raw.chunk.length === 0) return fail('chunk must be a non-empty string')
        if (raw.chunk.length > MAX_REWRITE_CHUNK_CHARS) {
          return fail(`chunk is ${raw.chunk.length} characters; maximum is ${MAX_REWRITE_CHUNK_CHARS}`)
        }
        const draft = (runState.rewriteDrafts.get(input.frame_id) ?? '') + raw.chunk
        if (draft.length > MAX_REWRITE_CHARS) {
          return fail(`rewrite draft exceeds the ${MAX_REWRITE_CHARS}-character safety limit`)
        }
        runState.rewriteDrafts.set(input.frame_id, draft)
        return ok(`appended ${raw.chunk.length} characters; draft is now ${draft.length} characters`)
      }
      case 'commit_frame_rewrite': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const draft = runState.rewriteDrafts.get(input.frame_id)
        if (draft === undefined) return fail('no rewrite draft; call begin_frame_rewrite first')
        const html = completeHtml(draft)
        if (!html)
          return fail('rewrite draft is not a complete HTML document ending in </html>; append the missing content')
        actions.updateFrame(input.frame_id, { html }, actor)
        runState.rewriteDrafts.delete(input.frame_id)
        runState.mutatedFrames.add(input.frame_id)
        runState.verifiedFrames.delete(input.frame_id)
        return ok(`committed ${html.length} characters — the new design is revealing to viewers now`)
      }
      case 'search_images': {
        if (!imageSearch.photoSearchEnabled())
          return fail('photo search is not configured on this server — draw the visual as inline SVG/CSS instead')
        const raw = block.input as { query?: string; orientation?: string; count?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const orientation = ['landscape', 'portrait', 'square'].includes(String(raw.orientation))
          ? (raw.orientation as imageSearch.PhotoOrientation)
          : undefined
        const photos = await imageSearch.searchPhotos(query, { orientation, count: Number(raw.count) || undefined })
        if (photos.length === 0) return ok(`no results for "${query}" — try a broader or more visual query`)
        const thumbs = await Promise.all(photos.map((p) => imageSearch.fetchThumb(p.thumb_url)))
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          { type: 'text', text: `${photos.length} photo(s) for "${query}" — thumbnails below, pick by number:` },
        ]
        photos.forEach((p, i) => {
          const thumb = thumbs[i]
          if (thumb)
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: thumb.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: thumb.data,
              },
            })
          blocks.push({
            type: 'text',
            text: `#${i + 1}${p.alt ? ` — ${p.alt}` : ''} (${p.width}×${p.height}, avg ${p.avg_color}, by ${p.photographer})\nimage_url: ${p.image_url}`,
          })
        })
        return ok(blocks)
      }
      case 'search_icons': {
        const raw = block.input as { query?: string; limit?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const icons = await imageSearch.searchIcons(query, { limit: Number(raw.limit) || undefined })
        if (icons.length === 0) return ok(`no results for "${query}" — try a synonym or broader concept`)
        return ok(
          `${icons.length} icon(s):\n${icons.map((icon) => `${icon.id} → ${icon.svg_url}`).join('\n')}\n\n${imageSearch.ICON_USAGE_NOTE}`,
        )
      }
      case 'search_logos': {
        const raw = block.input as { query?: string; count?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const { brands, vector } = await imageSearch.lookupLogos(query, Number(raw.count) || undefined)
        if (brands.length === 0 && vector.length === 0) {
          return ok(
            `no logo found for "${query}" — retry with the company's exact domain (e.g. "acme.io"), or draw a neutral wordmark in HTML/CSS instead of guessing a logo URL`,
          )
        }
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          { type: 'text', text: `Logo results for "${query}":` },
        ]
        if (brands.length > 0) {
          const thumbs = await Promise.all(brands.map((b) => imageSearch.fetchThumb(b.thumb_url)))
          brands.forEach((b, i) => {
            const thumb = thumbs[i]
            if (thumb)
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: thumb.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                  data: thumb.data,
                },
              })
            blocks.push({ type: 'text', text: `#${i + 1} — ${b.name} (${b.domain})\nlogo_url: ${b.logo_url}` })
          })
        }
        if (vector.length > 0) {
          blocks.push({
            type: 'text',
            text: `Open-source vector marks:\n${vector.map((v) => `${v.id} → ${v.svg_url}`).join('\n')}`,
          })
        }
        blocks.push({ type: 'text', text: imageSearch.LOGO_USAGE_NOTE })
        return ok(blocks)
      }
      case 'view_website': {
        const raw = block.input as { url?: string }
        const url = String(raw.url || '').trim()
        if (!url) return fail('url must be a non-empty string')
        const site = await viewWebsite(url)
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: site.screenshot.toString('base64') },
          },
          {
            type: 'text',
            text:
              `${site.title || site.finalUrl} — ${site.finalUrl}` +
              (site.description ? `\nMeta description: ${site.description}` : '') +
              (site.shotCropped
                ? `\nNote: the page is ${site.pageHeight}px tall — the screenshot shows only the top portion.`
                : '') +
              `\n\nVisible page text${site.textTruncated ? ' (truncated)' : ''}:\n${site.text}` +
              '\n\nRead-only view — nothing was added to the canvas.',
          },
        ]
        return ok(blocks)
      }
      case 'import_webpage': {
        const raw = block.input as { url?: string; as_reference?: boolean }
        const requestedUrl = String(raw.url || '').trim()
        if (!requestedUrl) return fail('url must be a non-empty string')
        if (typeof raw.as_reference !== 'boolean') {
          return fail(
            'as_reference must be true for source material or false when the import itself is the deliverable',
          )
        }

        const existing = raw.as_reference
          ? findImportedWebpageFrame(store.getCanvas(canvasId)?.frames ?? [], requestedUrl)
          : undefined
        if (existing) {
          runState.sourceFrames.add(existing.id)
          runState.verificationFrames.add(existing.id)
          runState.verifiedFrames.delete(existing.id)
          return ok(
            `Reusing the existing editable source snapshot ${existing.id} ("${existing.name}") for ${requestedUrl}; no duplicate frame was added. Call screenshot_frame with frame_id=${existing.id}. Leave this source frame unchanged and deliver the new design separately.`,
          )
        }

        const { frame: f } = await createImportedWebpageFrame({ canvasId, url: requestedUrl, actor })
        if (!f) return fail('canvas not found')
        runState.mutatedFrames.add(f.id)
        if (raw.as_reference) runState.sourceFrames.add(f.id)
        else runState.sourceFrames.delete(f.id)
        runState.verifiedFrames.delete(f.id)
        return ok(
          `Imported ${requestedUrl} as editable frame ${f.id} ("${f.name}", ${Math.round(f.width)}x${Math.round(f.height)}, ${f.html.length} HTML characters). Call screenshot_frame with frame_id=${f.id}.${
            raw.as_reference
              ? ' Leave this source frame unchanged and deliver the new design separately.'
              : ' This imported frame is the requested deliverable and may be edited directly.'
          }`,
        )
      }
      case 'get_reference': {
        const refs = store.getReferences(canvasId)
        const ref = refs.find((r) => r.id === input.reference_id)
        if (!ref) {
          const ids = refs.map((r) => `${r.id} ("${r.title}")`)
          return fail(
            ids.length
              ? `no reference with id ${input.reference_id} — this canvas has: ${ids.join(', ')}`
              : 'no style references pinned on this canvas',
          )
        }
        const snapshot: Frame = {
          id: `reference-${ref.id}`,
          canvasId,
          name: ref.title,
          x: 0,
          y: 0,
          width: ref.width,
          height: ref.height,
          html: ref.html,
          createdAt: ref.pinnedAt,
          updatedAt: ref.pinnedAt,
          updatedBy: ref.pinnedBy,
        }
        const blocks = await frameImageBlocks(snapshot)
        const truncated = ref.html.length > MAX_HTML_READ_CHARS
        blocks.push({
          type: 'text',
          text:
            `"${ref.title}" (${Math.round(ref.width)}x${Math.round(ref.height)}, pinned by ${ref.pinnedBy}) — match its palette, typography and spacing.\n\n` +
            `HTML${truncated ? ` (first ${MAX_HTML_READ_CHARS} of ${ref.html.length} characters — lift the design tokens from the <style> head and the screenshot)` : ''}:\n${ref.html.slice(0, MAX_HTML_READ_CHARS)}`,
        })
        return ok(blocks)
      }
      case 'get_style_recipe': {
        const recipe = getStyleRecipe(String(input.name ?? ''))
        if (!recipe) return fail(`no recipe named "${input.name}" — use a slug from the menu in your instructions`)
        return ok(`# ${recipe.title} (${recipe.category})\n\n${recipe.markdown}`)
      }
      case 'search_inspiration': {
        const raw = block.input as { query?: string; count?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const results = await searchInspiration(query, Number(raw.count) || 4)
        if (results.length === 0) return ok(`no inspiration for "${query}" — try a broader category`)
        const thumbs = await Promise.all(results.map((r) => imageSearch.fetchThumb(r.thumb_url)))
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          {
            type: 'text',
            text: `${results.length} exemplar(s) for "${query}" — study each thumbnail with its style facts:`,
          },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb)
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: thumb.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: thumb.data,
              },
            })
          blocks.push({ type: 'text', text: describeInspiration(r, i) })
        })
        blocks.push({ type: 'text', text: INSPIRATION_USAGE_NOTE })
        return ok(blocks)
      }
      case 'save_decision': {
        const decision = String(input.decision ?? '')
        try {
          const saved = actions.recordChatDecision(canvasId, decision, actor)
          if (saved === undefined) return fail('canvas not found')
          return ok(
            saved ? 'saved to the canvas Memory' : 'already in Memory — this exact decision was recorded before',
          )
        } catch (e) {
          return fail(e instanceof Error ? e.message : 'invalid decision')
        }
      }
      case 'set_guidelines': {
        const raw = block.input as { name?: string; markdown?: string; title?: string }
        if (typeof raw.name !== 'string' || !raw.name.trim()) return fail('name must be a non-empty slug')
        if (typeof raw.markdown !== 'string') return fail('markdown must be a string (empty string deletes the doc)')
        const doc = actions.setGuideline(canvasId, raw.name, raw.markdown, actor, undefined, raw.title)
        if (doc === undefined) return fail('canvas not found')
        return ok(
          doc
            ? `saved design guide "${actions.guidelineTitle(doc)}" (${doc.name}, ${doc.markdown.length} chars) — every actor on this canvas now inherits it`
            : `deleted design guide ${raw.name.trim().toLowerCase()}`,
        )
      }
      case 'screenshot_frame': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const blocks = await frameImageBlocks(f)
        if (runState.mutatedFrames.has(input.frame_id) || runState.verificationFrames.has(input.frame_id)) {
          runState.verifiedFrames.add(input.frame_id)
        }
        return ok(blocks)
      }
      default:
        return fail(`unknown tool ${block.name}`)
    }
  } catch (e) {
    const blocked = websiteAccessErrorMessage(e, 'resident')
    if (blocked) runState.blockedWebsiteAccess = blocked
    return fail(blocked ?? (e instanceof Error ? e.message : 'tool failed'))
  }
}
