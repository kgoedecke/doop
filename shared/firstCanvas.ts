/** Where a brand-new account lands: the server (server/index.ts) redirects
 *  it to the canvas signup created for them, where the demo agent is
 *  waiting to perform. Every signup path shares it — the email form, the
 *  Google / Microsoft / SSO callbacks (better-auth's newUserCallbackURL)
 *  and the desktop handoff — so no client has to guess which canvas that
 *  is. */
export const FIRST_CANVAS_PATH = '/api/welcome'

/** How an account was made. The email form knows at submit; a provider
 *  sign-in leaves for the IdP and only learns the account is new when it
 *  lands on FIRST_CANVAS_PATH, so that landing carries the method as
 *  ?signup=<method> through to the canvas, where the app reports it. */
export const SIGNUP_METHODS = ['email', 'google', 'microsoft', 'apple', 'oidc'] as const
export type SignupMethod = (typeof SIGNUP_METHODS)[number]

export const SIGNUP_PARAM = 'signup'

export function parseSignupMethod(raw: string | null | undefined): SignupMethod | null {
  return SIGNUP_METHODS.find((m) => m === raw) ?? null
}

/** FIRST_CANVAS_PATH for an account a provider sign-in just created. */
export function firstCanvasPathAfterSignup(method: SignupMethod): string {
  return `${FIRST_CANVAS_PATH}?${SIGNUP_PARAM}=${method}`
}
