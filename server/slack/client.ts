import { env } from '../env.ts'
import { z } from 'zod'

/**
 * Slack Web API errors surface as our own words plus Slack's error *code*
 * (a fixed enumeration such as `not_in_channel`), never its response text,
 * which can echo request or credential details.
 */
export class SlackError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code?: string,
  ) {
    super(message)
  }
}

const envelope = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough()

/** One Web API call with a bot token. `schema` validates the `ok: true` body. */
export async function slackApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${env.SLACK_API_URL}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new SlackError('Could not reach Slack. Try again.')
  }
  const body = envelope.safeParse(await response.json().catch(() => null))
  if (response.status === 429 || (body.success && body.data.error === 'ratelimited')) {
    throw new SlackError('Slack rate limit reached. Try again later.', 429, 'ratelimited')
  }
  if (!response.ok || !body.success) throw new SlackError('Slack could not complete this request.')
  if (!body.data.ok) {
    const code = body.data.error ?? 'unknown'
    if (['invalid_auth', 'account_inactive', 'token_revoked', 'not_authed'].includes(code)) {
      throw new SlackError('Slack revoked Doop’s access. Reinstall Doop in Slack.', 409, code)
    }
    throw new SlackError('Slack could not complete this request.', 502, code)
  }
  const parsed = schema.safeParse(body.data)
  if (!parsed.success) throw new SlackError('Slack returned an unexpected response.')
  return parsed.data
}

/** A slash command's response_url: valid for 30 minutes, up to five posts. */
export async function postToResponseUrl(responseUrl: string, payload: Record<string, unknown>): Promise<void> {
  let response: Response
  try {
    response = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new SlackError('Could not reach Slack. Try again.')
  }
  if (!response.ok) throw new SlackError('Slack could not complete this request.')
}

export const postedMessage = z.object({ ts: z.string().min(1), channel: z.string().min(1) })
