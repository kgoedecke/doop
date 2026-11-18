import type { TokenResult } from '../shared/designTokens.ts'
import { capture } from './analytics.ts'

/** Where a feature was used from: the app, an MCP agent, the resident Doop
 *  Agent, or an automation step. Features agents can reach report from the
 *  server, so the count includes the work done on a person's behalf. */
export type FeatureVia = 'ui' | 'mcp' | 'resident' | 'automation'

/** One use of a product feature, on the person it belongs to: the one
 *  signed in, the one who connected the agent, or the one who asked the
 *  resident agent. With no such person there is no one to count it on. */
export function captureFeature(
  userId: string | undefined,
  event: string,
  via: FeatureVia,
  properties: Record<string, unknown> = {},
) {
  if (!userId) return
  capture(userId, event, { ...properties, via })
}

/** A token write as one `tokens_changed`, counted by outcome; a write where
 *  every token failed is not a use. */
export function captureTokenResults(
  userId: string | undefined,
  canvasId: string,
  via: FeatureVia,
  results: TokenResult[] | undefined,
) {
  if (!results) return
  const counts = { created: 0, updated: 0, deleted: 0 }
  for (const r of results) if (r.result !== 'error') counts[r.result]++
  if (!counts.created && !counts.updated && !counts.deleted) return
  captureFeature(userId, 'tokens_changed', via, { canvas_id: canvasId, ...counts })
}
