import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { createInterface } from 'node:readline/promises'
import {
  CLI_EXCHANGE_PATH,
  CLI_SIGN_OUT_PATH,
  cliConnectURL,
  cliMachineName,
  type CliConnectRequest,
} from '../../shared/cliConnect.ts'
import { CliError, EXIT } from './errors.ts'

/**
 * `doop login` without a key: the person approves this CLI in their browser, and the server
 * hands it an agent key named after this machine (shared/cliConnect.ts has the whole flow).
 * The CLI listens on a port of the loopback address for the browser to come back to; with
 * `--no-browser`, or where it cannot listen, the person pastes the code the page shows. In CI
 * it refuses at once: nobody is there to approve.
 * Everything said along the way goes to stderr, so stdout stays the command's answer.
 */

const APPROVAL_TIMEOUT_MS = 5 * 60_000

export interface SignedIn {
  key: string
  user: { name: string; email: string }
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>doop</title>
<body style="font: 16px system-ui, sans-serif; margin: 20vh auto; max-width: 28em; text-align: center">
<h1 style="font-weight: 600; font-size: 24px">${title}</h1>
<p>${body}</p>`
}

function say(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** Opens `url` in the person's browser, if this machine has one to open. `BROWSER=none`
 *  says not to, as it does for other tools. No shell is involved on any platform: the
 *  link's `&` separators would be read by one as the end of the command. */
function openBrowser(url: string, env: NodeJS.ProcessEnv): void {
  if (env.BROWSER === 'none') return
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url]
  try {
    const child = spawn(command ?? 'open', args, { stdio: 'ignore', detached: true })
    /* no browser to open is not a failure: the link was printed */
    child.on('error', () => {})
    child.unref()
  } catch {
    /* the same */
  }
}

/** Waits for the browser to come back to the loopback address with the code of this attempt,
 *  trades it, and only then tells the tab how it went: the page must not say "signed in" for
 *  a code the server then refuses. */
function waitForKey(listener: Server, state: string, trade: (code: string) => Promise<SignedIn>): Promise<SignedIn> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new CliError(
            'nobody approved the sign-in within five minutes',
            EXIT.timeout,
            'run `doop login` again, or `doop login --no-browser` to paste a code instead',
          ),
        ),
      APPROVAL_TIMEOUT_MS,
    )
    let traded = false
    listener.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      /* anything else that finds the port is not this sign-in, and the code is traded once */
      if (traded || url.pathname !== '/callback' || !code || url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('This is not the sign-in the doop CLI is waiting for.')
        return
      }
      traded = true
      clearTimeout(timer)
      trade(code).then(
        (signedIn) => {
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(
              page(
                'Signed in.',
                'The doop CLI has what it needs. You can close this tab and go back to your terminal.',
              ),
            )
          resolve(signedIn)
        },
        (error: unknown) => {
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(page('That did not work.', 'The doop CLI could not finish signing in. Your terminal says why.'))
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  })
}

async function pasteCode(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new CliError(
      'there is no terminal to paste the code into',
      EXIT.auth,
      'run `doop login` where a browser can open, or sign in with a key: `doop login --key <key>`',
    )
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await prompt.question('Code: ')).trim()
  } finally {
    prompt.close()
  }
}

async function exchange(server: string, code: string, verifier: string): Promise<SignedIn> {
  let response: Response
  try {
    response = await fetch(`${server}${CLI_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
    })
  } catch (error) {
    throw new CliError(`could not reach ${server}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = (await response.json().catch(() => ({}))) as Partial<SignedIn> & { error?: string }
  if (response.ok && body.key && body.user) return { key: body.key, user: body.user }
  /* a server from before this sign-in answers the path with its app's page */
  if (!body.error)
    throw new CliError(
      `${server} has no browser sign-in for the CLI`,
      EXIT.auth,
      'make a key in Settings → Agent keys and run `doop login --key <key>`',
    )
  throw new CliError(body.error, EXIT.auth)
}

/** Deletes a key this CLI was handed, on the server. False when the server could not be
 *  reached: the key is forgotten here either way, and can be removed in Settings. */
export async function revokeKey(server: string, key: string): Promise<boolean> {
  try {
    const response = await fetch(`${server}${CLI_SIGN_OUT_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    })
    return response.status === 204
  } catch {
    return false
  }
}

/** A loopback port to hear the browser on, or null where this machine will not give one
 *  (a sandbox, a container without a loopback interface). */
function listen(): Promise<Server | null> {
  const listener = createServer()
  return new Promise((resolve) => {
    listener.once('error', () => resolve(null))
    listener.listen(0, '127.0.0.1', () => resolve(listener))
  })
}

export async function browserLogin(server: string, env: NodeJS.ProcessEnv, noBrowser: boolean): Promise<SignedIn> {
  /* nobody is there to approve in a pipeline, and waiting five minutes for them stalls it */
  if (env.CI)
    throw new CliError(
      'there is nobody to approve a browser sign-in in CI',
      EXIT.auth,
      'make an agent key in Settings → Agent keys and set DOOP_API_KEY, or run `doop login --key <key>`',
    )
  const verifier = randomBytes(32).toString('base64url')
  const request: CliConnectRequest = {
    state: randomBytes(16).toString('hex'),
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    name: cliMachineName(hostname().replace(/\.local$/, '')),
  }
  const listener = noBrowser ? null : await listen()
  if (!listener) {
    if (!noBrowser) say('This machine gave the CLI no port to hear the browser on: paste the code instead.')
    say(`Open this link on any device, sign in and approve:\n\n  ${cliConnectURL(server, request)}\n`)
    say('Then paste the code it shows here.')
    return exchange(server, await pasteCode(), verifier)
  }
  try {
    const url = cliConnectURL(server, { ...request, port: (listener.address() as AddressInfo).port })
    say(`Approve the doop CLI in your browser to finish signing in:\n\n  ${url}\n`)
    say('Waiting for the approval… (no browser on this machine? run `doop login --no-browser`)')
    openBrowser(url, env)
    return await waitForKey(listener, request.state, (code) => exchange(server, code, verifier))
  } finally {
    listener.close()
    listener.closeAllConnections()
  }
}
