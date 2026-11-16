/** Feedback a person leaves the Doop team from the app (the rail, the account
 *  menu, the canvas Help menu). Agents have their own channel: agentFeedback. */

export const MAX_PRODUCT_FEEDBACK_CHARS = 2000

export interface ProductFeedbackInput {
  message: string
  /** the path the person was on, for context; never trusted beyond display */
  page?: string
}

/** The request body as feedback, or null when it carries no usable message. */
export function parseProductFeedback(body: unknown): ProductFeedbackInput | null {
  if (!body || typeof body !== 'object') return null
  const { message, page } = body as { message?: unknown; page?: unknown }
  if (typeof message !== 'string') return null
  const clean = message.trim()
  if (!clean || clean.length > MAX_PRODUCT_FEEDBACK_CHARS) return null
  return { message: clean, ...(typeof page === 'string' && page ? { page: page.slice(0, 300) } : {}) }
}
