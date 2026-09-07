import Anthropic from '@anthropic-ai/sdk'
import { ANTHROPIC_TIMEOUT_MS } from './anthropicTimeout.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'

/**
 * The Memory distiller: when enough undistilled design decisions pile up on a
 * canvas, a small model reads them and — if a durable preference shows through
 * — proposes ONE rule to add to a style guide. The proposal is only ever
 * pending: a human accepts it into the guide (versioned like any edit) or
 * dismisses it. Auto-committed memory goes noisy; curated memory stays trusted.
 *
 * Event-driven, not scheduled: captureDecision pokes maybeDistill, so quiet
 * canvases cost nothing. Enabled when ANTHROPIC_API_KEY is set; silently
 * disabled otherwise, like the resident agents.
 */

const MODEL = process.env.DOOP_DISTILL_MODEL || 'claude-haiku-4-5-20251001'
/** most recent unconsumed decisions the judge sees per run */
const MAX_WINDOW = 15

let client: Anthropic | null = null

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null
  if (!client) client = new Anthropic({ timeout: ANTHROPIC_TIMEOUT_MS })
  return client
}

const running = new Set<string>()

/** A decision was captured: generalize its raw words into a short preference
 *  ("more white and blue, not so claude-esque" → "Prefer white and blue…"),
 *  then check whether enough decisions accumulated to propose a rule. */
export function onDecision(canvasId: string, decisionId: string) {
  if (!getClient()) return
  summarizeDecision(canvasId, decisionId)
    .catch((err) => console.error('[distill] summarize failed', err))
    .finally(() => maybeDistill(canvasId))
}

async function summarizeDecision(canvasId: string, decisionId: string) {
  const anthropic = getClient()
  const decision = actions.getDecisions(canvasId).find((d) => d.id === decisionId)
  if (!anthropic || !decision || decision.summary) return
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: `Raw design feedback a human gave an agent on a shared canvas (the agent carried it out):
"${decision.text}"

Rewrite it as ONE short, general style preference for this project's design memory. Generalize from the specific instance to the underlying taste — e.g. "make this button blue like the others" becomes "Prefer blue accent buttons". Imperative, under 90 characters, no quotes, no trailing period. Reply with the preference only.`,
      },
    ],
  })
  const summary = res.content
    .filter((b): b is (typeof res.content)[number] & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim()
    .replace(/^["“]+|["”.]+$/g, '')
    .slice(0, 120)
  if (summary) {
    actions.setDecisionSummary(canvasId, decisionId, summary)
    console.log(`[distill] summarized canvas=${canvasId} "${decision.text.slice(0, 40)}…" -> "${summary}"`)
  }
}

/* Every captured decision gets judged — no "wait for N" gate. Whether one
   decision warrants a rule is a semantic question ("never use italics" is a
   standing rule on its own; "nudge this button left" is not), so the bar
   lives in the judge prompt, not in a counter. Decisions are only consumed
   when a rule IS proposed, so slow-building patterns keep their evidence. */
export function maybeDistill(canvasId: string) {
  if (!getClient() || running.has(canvasId)) return
  if (actions.undistilledDecisions(canvasId).length === 0) return
  /* one open proposal at a time — a stack of pending cards reads as spam */
  if (actions.getProposals(canvasId).some((p) => p.status === 'pending')) return
  running.add(canvasId)
  distill(canvasId)
    .catch((err) => console.error('[distill] run failed', err))
    .finally(() => running.delete(canvasId))
}

const DISTILL_TOOL: Anthropic.Tool = {
  name: 'distill_result',
  description: 'Report whether the decisions contain a durable style rule worth adding to a guide.',
  input_schema: {
    type: 'object',
    properties: {
      has_rule: {
        type: 'boolean',
        description: 'true only if a durable, recurring preference shows through — not a one-off request',
      },
      guide_name: {
        type: 'string',
        description:
          'Slug of the guide the rule belongs in — an existing one when it fits, else a new slug (a-z, 0-9, hyphens)',
      },
      guide_title: { type: 'string', description: 'Pretty display name for the guide if it is new' },
      rule: {
        type: 'string',
        description:
          'The rule as one markdown bullet an agent can execute, e.g. "- Buttons: always fully rounded (border-radius: 999px)"',
      },
      rationale: { type: 'string', description: 'One sentence: which decisions show this and why it is a rule' },
    },
    required: ['has_rule'],
  },
}

async function distill(canvasId: string) {
  const anthropic = getClient()
  if (!anthropic) return
  const decisions = actions.undistilledDecisions(canvasId).slice(0, MAX_WINDOW)
  if (decisions.length === 0) return
  const guides = store.getGuidelines(canvasId)

  const guideList = guides.length
    ? guides.map((g) => `- ${g.name} ("${actions.guidelineTitle(g)}"): ${actions.guidelineSummary(g)}`).join('\n')
    : '(none yet)'
  const decisionList = decisions
    .map((d) =>
      d.summary
        ? `- [${d.id}] ${d.summary} (${d.from}'s words: "${d.text}")`
        : `- [${d.id}] ${d.from} asked${d.agentName ? ` ${d.agentName}` : ''}: "${d.text}"`,
    )
    .join('\n')
  /* what was already pitched: never re-propose a dismissed rule, don't repeat
     an accepted one (it lives in a guide now anyway) */
  const priorProposals = actions
    .getProposals(canvasId)
    .filter((p) => p.status !== 'pending')
    .slice(0, 5)
  const proposalList = priorProposals.length
    ? priorProposals.map((p) => `- [${p.status}] ${p.rule}`).join('\n')
    : '(none)'

  const prompt = `You maintain the design memory of a shared canvas. Humans gave agents the following feedback, and each item below was carried out — they are settled decisions, newest first:

${decisionList}

Style guides already on this canvas:
${guideList}

Rules previously suggested from this memory (dismissed = the human rejected it; never re-propose it or a trivial variant):
${proposalList}

If these decisions reveal a durable style preference, distill it into ONE markdown bullet for the most fitting guide. Judge by substance, not count:
- ONE decision is enough when it is stated as a standing preference — "never/always …", "keep that as our signature style", "prefer X over Y", or a general taste like "less claude-esque, more white and blue".
- Several decisions correcting in the same direction are enough even if each was phrased as a one-off.
- A single tweak scoped to one design ("nudge this button left", "fix this heading") is NOT a rule — report has_rule: false and wait for more evidence.
Do not restate anything a guide already covers. Prefer an existing guide's slug; invent a new slug only when nothing fits.`

  console.log(`[distill] run canvas=${canvasId} decisions=${decisions.length}`)
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    tools: [DISTILL_TOOL],
    tool_choice: { type: 'tool', name: 'distill_result' },
    messages: [{ role: 'user', content: prompt }],
  })

  const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  const input = (block?.input ?? {}) as {
    has_rule?: boolean
    guide_name?: string
    guide_title?: string
    rule?: string
    rationale?: string
  }
  if (!input.has_rule || !input.rule?.trim()) {
    console.log(`[distill] no rule canvas=${canvasId}`)
    return
  }
  const slug = (input.guide_name ?? 'style-notes')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  const proposal = actions.addProposal(canvasId, {
    guideName: actions.GUIDELINE_NAME_RE.test(slug) ? slug : 'style-notes',
    guideTitle: input.guide_title?.trim().slice(0, 80) || undefined,
    rule: input.rule.trim(),
    rationale: input.rationale?.trim() || 'Distilled from recent feedback.',
    basedOn: decisions.map((d) => d.id),
  })
  /* evidence is consumed only when it turns into a proposal — a "no rule yet"
     verdict leaves the decisions in the window so a slow-building pattern is
     never buried. Re-runs only happen on NEW captures, so this cannot loop. */
  actions.markDecisionsDistilled(
    canvasId,
    decisions.map((d) => d.id),
  )
  console.log(`[distill] proposed canvas=${canvasId} guide=${proposal.guideName} rule=${proposal.rule.slice(0, 80)}`)
}
