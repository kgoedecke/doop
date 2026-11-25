import { callJson } from './client.ts'
import type { Context, Outcome } from './context.ts'
import { CliError, EXIT, usage } from './errors.ts'
import { saveCommentsSeen } from './project.ts'

/**
 * `doop wait`: block until a person asks for something on the canvas, print it, exit. An agent
 * runs it as a background command and is woken by its exit, which is the wake-on-feedback MCP
 * cannot give (it is pull-only). It polls the same tools an MCP agent would call: `get_feedback`
 * (which claims the requests for this agent) and `get_comments`.
 */

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000
/** a server restart or a dropped connection is waited out; this many in a row is an outage */
const MAX_FAILED_POLLS = 5

interface Feedback {
  from: string
  text: string
  about?: string
  at: string
}

interface Comment {
  id: string
  frameId?: string
  elementId?: string
  parentId?: string
  from: string
  text: string
  at: number
}

/** "90s", "30m", "2h", or a bare number of seconds; 0 waits without limit. */
export function parseDuration(raw: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim())
  if (!match) throw usage(`--${flag} takes a duration such as 90s, 30m or 2h, got "${raw}"`)
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 's'] ?? 1_000
  return Number(match[1]) * unit
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function wait(context: Context): Promise<Outcome> {
  const canvasId = context.canvasId()
  /* neither flag means both */
  const both = !context.flags.feedback && !context.flags.comments
  const wantFeedback = both || context.flags.feedback === true
  const wantComments = both || context.flags.comments === true
  const timeout = context.flags.timeout ? parseDuration(context.flags.timeout, 'timeout') : DEFAULT_TIMEOUT_MS
  const interval = Math.max(
    MIN_INTERVAL_MS,
    context.flags.interval ? parseDuration(context.flags.interval, 'interval') : DEFAULT_INTERVAL_MS,
  )
  const frame = context.flags.frame ? await context.resolveFrame(context.flags.frame) : undefined
  const me = context.connection.agentName

  const readComments = async (): Promise<Comment[]> =>
    (
      await callJson<Comment[]>(context.connection, 'get_comments', {
        canvas_id: canvasId,
        include_resolved: false,
        ...(frame ? { frame_id: frame.id } : {}),
      })
    ).value
  /* What counts as new: comments after the newest one the last wait saw, by the server's own
     clock. A directory keeps that mark between runs, so a comment left while the agent was
     working is reported by the next wait; with no mark yet, this run starts from what is there. */
  const newest = (comments: Comment[]) => comments.reduce((latest, comment) => Math.max(latest, comment.at), 0)
  const project = context.project?.config.canvas === canvasId && !frame ? context.project : null
  let since = wantComments ? (project?.commentsSeenAt ?? newest(await readComments())) : 0
  const remember = (comments: Comment[]) => {
    since = Math.max(since, newest(comments))
    if (!project || project.commentsSeenAt === since) return
    saveCommentsSeen(project, since)
  }
  remember([])

  const deadline = timeout > 0 ? Date.now() + timeout : Number.POSITIVE_INFINITY
  let failures = 0
  for (;;) {
    try {
      /* comments first: reading them claims nothing, so a failure there loses nothing.
         get_feedback assigns what it returns to this agent, and nothing may fail after it */
      const comments = wantComments
        ? (await readComments()).filter((comment) => comment.at > since && comment.from !== me)
        : []
      const feedback = wantFeedback
        ? (await callJson<{ feedback: Feedback[] }>(context.connection, 'get_feedback', { canvas_id: canvasId })).value
            .feedback
        : []
      failures = 0
      remember(comments)
      if (feedback.length || comments.length)
        return {
          text: [
            ...feedback.map(
              (item) => `feedback from ${item.from}${item.about ? ` (about ${item.about})` : ''}: ${item.text}`,
            ),
            ...comments.map(
              (comment) =>
                `comment ${comment.id} from ${comment.from}${comment.frameId ? ` on frame ${comment.frameId}` : ''}${comment.elementId ? ` element ${comment.elementId}` : ''}: ${comment.text}`,
            ),
            ...(feedback.length
              ? ['The feedback is now assigned to you: address it, then check with `doop screenshot`.']
              : []),
            ...(comments.length
              ? ['Answer a comment with `doop call reply_to_comment comment_id=<id> text="…"`.']
              : []),
          ].join('\n'),
          data: { feedback, comments },
        }
    } catch (error) {
      /* a wrong key or a missing canvas will not fix itself */
      if (error instanceof CliError && error.exitCode !== EXIT.error) throw error
      failures += 1
      if (failures >= MAX_FAILED_POLLS) throw error
    }
    if (Date.now() + interval > deadline)
      return {
        text: `nothing from people on the canvas within ${context.flags.timeout ?? '30m'}; run \`doop wait\` again to keep waiting`,
        data: { feedback: [], comments: [], timedOut: true },
        exitCode: EXIT.timeout,
      }
    await sleep(interval)
  }
}
