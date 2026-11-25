/* Signing the doop CLI in from a browser (`doop login`, cli/doop/login.ts). The flow, after
   the editor extension's (shared/editorConnect.ts):

     1. The CLI makes a random `state` and a secret `verifier`, listens on a port of this
        machine's loopback address, and opens CLI_CONNECT_PATH in the browser with the state,
        the port, the machine's name and the verifier's hash (`challenge`).
     2. That page (src/pages/CliConnect.tsx), signed in, asks the person to confirm, and the
        server mints a short-lived exchange code. The browser goes to the CLI's loopback
        address with `code` and `state`: never a key, which would sit in the browser's history.
     3. The CLI checks `state` and trades the code and its verifier (CLI_EXCHANGE_PATH) for an
        agent key named after the machine, minted then. The server gives the key only to the
        holder of the verifier, so a code seen by something else on the way is of no use to it.

   Without a browser on the machine (`doop login --no-browser`, over SSH) there is no port: the
   page shows the code, and the person pastes it into the terminal. The key is an ordinary
   agent key, revoked like any other in Settings → Connect AI.

   Pure functions, shared by the page, the server and the CLI. */

export const CLI_CONNECT_PATH = '/cli/connect'
export const CLI_EXCHANGE_PATH = '/cli/exchange'
/** `doop logout`: deletes the key a browser sign-in minted, so signing in again does not pile keys up */
export const CLI_SIGN_OUT_PATH = '/cli/sign-out'

const STATE_PATTERN = /^[0-9a-f]{32}$/
/** a SHA-256 in base64url: what the CLI's verifier hashes to */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_NAME = 40
/** ports a program may listen on without privileges */
const MIN_PORT = 1024
const MAX_PORT = 65535

export interface CliConnectRequest {
  /** the CLI's random per-attempt value, handed back unchanged */
  state: string
  /** the hash of the secret the CLI will prove it holds when it trades the code */
  challenge: string
  /** the machine the CLI runs on, for the key's name */
  name: string
  /** where the CLI listens on this machine; absent when the person pastes the code instead */
  port?: number
}

/** The machine's name as a key is named after it: printable, single-line, short. */
export function cliMachineName(raw: string): string {
  const printable = [...raw].map((char) => (char < ' ' || char === '\u007f' ? ' ' : char)).join('')
  /* cut by character, not by UTF-16 unit: half an emoji is not a name */
  return [...printable.replace(/\s+/g, ' ').trim()].slice(0, MAX_NAME).join('').trim() || 'this computer'
}

/** A request as the page or the server was handed it, or null when it is incomplete or
 *  malformed: every field is checked on both sides. */
export function parseCliConnect(input: {
  state?: unknown
  challenge?: unknown
  name?: unknown
  port?: unknown
}): CliConnectRequest | null {
  const state = typeof input.state === 'string' ? input.state : ''
  const challenge = typeof input.challenge === 'string' ? input.challenge : ''
  if (!STATE_PATTERN.test(state) || !CHALLENGE_PATTERN.test(challenge)) return null
  const name = cliMachineName(typeof input.name === 'string' ? input.name : '')
  if (input.port === undefined || input.port === null || input.port === '') return { state, challenge, name }
  const port =
    typeof input.port === 'number' ? input.port : /^\d{1,5}$/.test(String(input.port)) ? Number(input.port) : NaN
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null
  return { state, challenge, name, port }
}

export function parseCliConnectQuery(search: string): CliConnectRequest | null {
  const query = new URLSearchParams(search)
  return parseCliConnect({
    state: query.get('state') ?? undefined,
    challenge: query.get('challenge') ?? undefined,
    name: query.get('name') ?? undefined,
    port: query.get('port') ?? undefined,
  })
}

/** The page the CLI opens on `server`. */
export function cliConnectURL(server: string, request: CliConnectRequest): string {
  const url = new URL(CLI_CONNECT_PATH, server)
  url.searchParams.set('state', request.state)
  url.searchParams.set('challenge', request.challenge)
  url.searchParams.set('name', request.name)
  if (request.port !== undefined) url.searchParams.set('port', String(request.port))
  return url.href
}

/** Where the browser hands the code to a CLI that is listening: this machine's loopback
 *  address and nothing else, so a link cannot send a fresh code to another host. Null when
 *  the CLI is not listening and the code is pasted. */
export function cliCallbackURL(request: CliConnectRequest, code: string): string | null {
  if (request.port === undefined) return null
  const url = new URL(`http://127.0.0.1:${request.port}/callback`)
  url.searchParams.set('code', code)
  url.searchParams.set('state', request.state)
  return url.href
}
