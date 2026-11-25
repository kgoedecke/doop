/* The app's sign-in page. Every server redirect that needs someone signed in
   goes here, never to `/`: a deployment may serve a landing page at a
   signed-out `/`, which has no sign-in form. The page resumes an
   interrupted flow from its query (`redirect_to`, an MCP authorize request). */
export const SIGN_IN_PATH = '/auth'

/* Query parameters that mean "sign in, then carry on": a signed-out `/`
   carrying one stays with the app, so the flow survives. */
export const SIGN_IN_RESUME_PARAMS = ['redirect_to', 'client_id'] as const

const ERROR_PARAMS = ['error', 'error_description']

/** `search` without a provider's error parameters, keeping everything else
 *  (an interrupted MCP authorize request above all). Leading `?` or none. */
export function withoutSignInError(search: string): string {
  const params = new URLSearchParams(search)
  for (const name of ERROR_PARAMS) params.delete(name)
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}
