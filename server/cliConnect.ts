import { createHash, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import { CLI_EXCHANGE_PATH, CLI_SIGN_OUT_PATH, cliCallbackURL, parseCliConnect } from '../shared/cliConnect.ts'
import { answerWithKey, deleteOwnKey, rememberPending, takePending } from './editorConnect.ts'

/* The server half of the doop CLI's browser sign-in (shared/cliConnect.ts):

   - POST /api/cli/connect (signed in): the person approved the CLI on the page. Answers a
     two-minute exchange code: as the loopback address to go to when the CLI is listening,
     else as the code itself, for the person to paste into the terminal.
   - POST /cli/exchange: the CLI trades the code, once, for an agent key named after its
     machine. It must send the verifier whose hash came with the approval, so the key goes to
     the program that started the sign-in and to nothing that merely saw the code. The key is
     minted there (`answerWithKey`, the editor extension's ending too), not at approval.
   - POST /cli/sign-out (Bearer agent key): `doop logout` deletes the key it was handed.

   Codes live in memory, as the editor extension's do (server/editorConnect.ts). */

const CODE_TTL_MS = 2 * 60_000

interface Code {
  userId: string
  expires: number
  /** the key's name: the machine it is for */
  name: string
  challenge: string
}

const codes = new Map<string, Code>()

function proves(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false
  const hashed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return hashed.length === expected.length && timingSafeEqual(hashed, expected)
}

/** Routes the session gate must not cover: mounted before it. */
export function mountCliPublicRoutes(app: Express): void {
  app.post(CLI_EXCHANGE_PATH, async (req: Request, res: Response) => {
    /* taken before it is checked: a wrong verifier uses the code up */
    const entry = takePending(codes, req.body?.code)
    if (!entry || !proves(req.body?.verifier, entry.challenge))
      return res.status(400).json({ error: 'this sign-in expired — run `doop login` again' })
    await answerWithKey(res, entry.userId, entry.name)
  })

  app.post(CLI_SIGN_OUT_PATH, deleteOwnKey)
}

/** Behind the session gate: the signed-in browser approves the CLI. */
export function mountCliSessionRoutes(app: Express): void {
  app.post('/api/cli/connect', (req: Request, res: Response) => {
    const request = parseCliConnect(req.body ?? {})
    if (!request) return res.status(400).json({ error: 'this link is not from the doop CLI' })
    const code = rememberPending(codes, {
      userId: req.user!.id,
      name: `doop CLI on ${request.name}`,
      challenge: request.challenge,
      expires: Date.now() + CODE_TTL_MS,
    })
    const url = cliCallbackURL(request, code)
    res.json(url ? { url } : { code })
  })
}
