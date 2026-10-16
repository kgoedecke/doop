/** Where a brand-new account lands: the server (server/index.ts) redirects
 *  it to the canvas signup created for them, where the demo agent is
 *  waiting to perform. Every signup path shares it — the email form, the
 *  Google / Microsoft / SSO callbacks (better-auth's newUserCallbackURL)
 *  and the desktop handoff — so no client has to guess which canvas that
 *  is. */
export const FIRST_CANVAS_PATH = '/api/welcome'
