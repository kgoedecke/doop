import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import {
  EDITOR_CONNECT_PATH,
  EDITOR_EMBED_TICKET_PATH,
  EDITOR_EXCHANGE_PATH,
  EDITOR_SIGN_OUT_PATH,
  EDITOR_WHOAMI_PATH,
} from '../../shared/editorConnect.ts'
import { DoopError, postJson, serverUrl } from './server.ts'

/* Who the extension acts as: one Doop agent key per server, kept in the
   editor's secret storage. Signing in runs the browser hand-off of
   shared/editorConnect.ts; a key pasted from Settings → Connect AI works the
   same. The key signs the MCP calls (the canvas list, a new canvas), the MCP
   server the editor's own agents get, and the tickets that sign the canvas
   view in. */

const KEY_PREFIX = 'doop.key:'
const USER_PREFIX = 'doop.user:'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const REPLACED = 'Replaced by a newer sign-in.'
const CANCELLED = 'Sign-in cancelled.'

/** What a canvas view loads with: a ticket, nobody signed in, or a server that did not answer. */
export type EmbedTicket = { ticket: string } | { signedOut: true } | { error: string }

export interface DoopUser {
  name: string
  email: string
}

interface Pending {
  state: string
  resolve: (code: string) => void
  reject: (err: Error) => void
}

export class Auth implements vscode.UriHandler {
  private pending: Pending | null = null
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async key(): Promise<string | undefined> {
    return this.context.secrets.get(KEY_PREFIX + serverUrl())
  }

  user(): DoopUser | undefined {
    return this.context.globalState.get<DoopUser>(USER_PREFIX + serverUrl())
  }

  async signedIn(): Promise<boolean> {
    return !!(await this.key())
  }

  /** The deep link VS Code (or the fork running us) hands to the browser. */
  handleUri(uri: vscode.Uri): void {
    if (uri.path !== '/auth') return
    const query = new URLSearchParams(uri.query)
    const pending = this.pending
    this.log.info('Sign-in link received.')
    if (!pending || query.get('state') !== pending.state) {
      void vscode.window.showWarningMessage('Doop: ignored a sign-in link this editor did not ask for.')
      return
    }
    const code = query.get('code')
    if (code) pending.resolve(code)
    else pending.reject(new DoopError('The sign-in link carried no code.'))
  }

  async signIn(): Promise<boolean> {
    const state = randomBytes(16).toString('hex')
    /* the editor's own deep link. Not asExternalUri: on the desktop it only adds a
       `windowId`, folded into the path where no URL parser finds it again; the
       editor hands an /auth link to its focused window anyway. */
    const callback = `${vscode.env.uriScheme}://${this.context.extension.id.toLowerCase()}/auth`
    const url = new URL(EDITOR_CONNECT_PATH, serverUrl())
    url.searchParams.set('redirect', callback)
    url.searchParams.set('state', state)

    this.pending?.reject(new DoopError(REPLACED))
    const code = new Promise<string>((resolve, reject) => {
      this.pending = { state, resolve, reject }
    })
    this.log.info(`Sign-in page: ${url.href}`)
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url.href, true))
    if (!opened) this.log.warn('The browser did not open; open the sign-in page above by hand.')

    try {
      const answer = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Doop: finish signing in in your browser (${new URL(serverUrl()).host})…`,
          cancellable: true,
        },
        async (_progress, token) => {
          const cancelled = new Promise<never>((_, reject) => {
            token.onCancellationRequested(() => reject(new DoopError(CANCELLED)))
            setTimeout(() => reject(new DoopError('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS)
          })
          const received = await Promise.race([code, cancelled])
          return postJson<{ key: string; user: DoopUser }>(EDITOR_EXCHANGE_PATH, { code: received })
        },
      )
      await this.store(answer.key, answer.user)
      void vscode.window.showInformationMessage(`Doop: signed in as ${answer.user.email}.`)
      return true
    } catch (err) {
      const quiet = err instanceof DoopError && (err.message === CANCELLED || err.message === REPLACED)
      if (!quiet) void vscode.window.showErrorMessage(`Doop: ${(err as Error).message}`)
      return false
    } finally {
      /* a newer sign-in may have taken over meanwhile: leave its entry alone */
      if (this.pending?.state === state) this.pending = null
    }
  }

  async useAgentKey(): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: 'Sign in to Doop with an agent key',
      prompt: `Create one on ${new URL(serverUrl()).host} in Settings → Connect AI → Agent keys.`,
      placeHolder: 'dpk_…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (/^dpk_[\w-]{20,}$/.test(value.trim()) ? null : 'An agent key starts with dpk_'),
    })
    if (!key) return false
    try {
      const { user } = await postJson<{ user: DoopUser }>(EDITOR_WHOAMI_PATH, {}, key.trim())
      await this.store(key.trim(), user)
      void vscode.window.showInformationMessage(`Doop: signed in as ${user.email}.`)
      return true
    } catch (err) {
      void vscode.window.showErrorMessage(`Doop: ${(err as Error).message}`)
      return false
    }
  }

  /** Forgets the key here and deletes it on the server, which also signs out the canvas views it signed in. */
  async signOut(): Promise<void> {
    const key = await this.key()
    if (key)
      await postJson(EDITOR_SIGN_OUT_PATH, {}, key).catch((err: unknown) =>
        this.log.warn(`Could not revoke the key on the server: ${(err as Error).message}`),
      )
    await this.forget()
  }

  private async forget(): Promise<void> {
    await this.context.secrets.delete(KEY_PREFIX + serverUrl())
    await this.context.globalState.update(USER_PREFIX + serverUrl(), undefined)
    this.changed.fire()
  }

  /** A one-minute ticket that signs one canvas view in. Forgets the key when the server says it was revoked. */
  async embedTicket(): Promise<EmbedTicket> {
    const key = await this.key()
    if (!key) return { signedOut: true }
    try {
      const { ticket, user } = await postJson<{ ticket: string; user: DoopUser }>(EDITOR_EMBED_TICKET_PATH, {}, key)
      await this.context.globalState.update(USER_PREFIX + serverUrl(), user)
      return { ticket }
    } catch (err) {
      if (err instanceof DoopError && err.status === 401) {
        await this.forget()
        void vscode.window.showWarningMessage('Doop: your sign-in was revoked. Sign in again.')
        return { signedOut: true }
      }
      return { error: (err as Error).message }
    }
  }

  private async store(key: string, user: DoopUser): Promise<void> {
    await this.context.secrets.store(KEY_PREFIX + serverUrl(), key)
    await this.context.globalState.update(USER_PREFIX + serverUrl(), user)
    this.changed.fire()
  }

  /** Fired by the extension when the server setting changes: another server, another key. */
  serverChanged(): void {
    this.changed.fire()
  }
}
