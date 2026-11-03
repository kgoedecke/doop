/**
 * Reading a failed better-auth call.
 *
 * The client hands back whatever JSON the response carried, so `error.code` is
 * one of better-auth's own SCREAMING_SNAKE codes — as long as our server is
 * what answered. Anything sitting in front of it answers in its own shape:
 * Railway's edge replies
 * `{"status":"error","code":502,"message":"Application failed to respond"}`
 * (and 404 / 429 in the same shape) whenever it cannot reach the container,
 * which every deploy's restart window produces. better-fetch spreads that body
 * straight into `error`, numeric `code` and all, so a code match has to treat
 * a non-string code as "not one of ours" rather than call a string method on
 * it — doing that threw inside the submit handler and the form went quiet
 * without ever showing why.
 */

/** The error better-auth's client resolves with: the response body, widened. */
export interface AuthClientError {
  code?: unknown
  message?: unknown
}

/** A code we did not send, i.e. a body from in front of the app. */
function foreign(error: AuthClientError): boolean {
  return error.code !== undefined && error.code !== null && typeof error.code !== 'string'
}

/** The call's own error code, or '' when the body wasn't one of ours. */
export function authErrorCode(error: AuthClientError): string {
  return typeof error.code === 'string' ? error.code : ''
}

/**
 * What to tell a person about a failed call. A platform error's own wording
 * ("Application not found") describes our deployment, not anything they did
 * or can fix, so it becomes `unreachable`, a plain try-again in the person's
 * language (`auth.unreachable`), instead.
 */
export function authErrorMessage(error: AuthClientError, fallback: string, unreachable: string): string {
  if (foreign(error)) return unreachable
  return typeof error.message === 'string' ? error.message : fallback
}
