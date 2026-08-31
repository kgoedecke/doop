import { createAuthClient } from 'better-auth/react'
import { genericOAuthClient } from 'better-auth/client/plugins'

/** Same-origin better-auth client — cookies do the rest. */
export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
})
