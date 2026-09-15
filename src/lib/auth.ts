import { createAuthClient } from 'better-auth/react'
import { genericOAuthClient, oneTimeTokenClient } from 'better-auth/client/plugins'

/** Same-origin better-auth client — cookies do the rest. The one-time token
 *  plugin carries a sign-in from the system browser into the desktop shell
 *  (src/lib/desktopAuth.ts). */
export const authClient = createAuthClient({
  plugins: [genericOAuthClient(), oneTimeTokenClient()],
})
