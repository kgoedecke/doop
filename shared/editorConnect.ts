/* Connecting a code editor (the Doop extension for VS Code and its forks:
   Cursor, Windsurf, VSCodium…) to a Doop account. The extension lives in
   `vscode-extension/`; the flow is:

     1. The editor opens EDITOR_CONNECT_PATH in the system browser with a
        random `state` and the editor's own deep link as `redirect`
        (`<uriScheme>://doop.doop/auth`, built by hand: `vscode.env.asExternalUri`
        folds a `windowId` into the path, which editorRedirect then refuses).
     2. That page (src/pages/EditorConnect.tsx), signed in, asks the person to
        confirm, and the server mints a short-lived exchange code. The browser
        follows the deep link with `code` and `state`: never a key, which would
        sit in the browser's history.
     3. The extension checks `state` and trades the code (EDITOR_EXCHANGE_PATH)
        for an agent key named after the editor, minted then, which it keeps in
        the editor's secret storage. Signing out (EDITOR_SIGN_OUT_PATH) deletes it. The
        key is an ordinary agent key: it drives /mcp for the editor's agents and
        is revoked like any other, in Settings → Connect AI.

   Pure functions, shared by the page and the server. */

export const EDITOR_CONNECT_PATH = '/editor/connect'
export const EDITOR_EXCHANGE_PATH = '/editor/exchange'
export const EDITOR_EMBED_TICKET_PATH = '/editor/embed-ticket'
export const EDITOR_WHOAMI_PATH = '/editor/whoami'
export const EDITOR_SIGN_OUT_PATH = '/editor/sign-out'
export const EDITOR_EMBED_PATH = '/editor/embed'

/** The extension's id (`publisher.name` in vscode-extension/package.json), as an editor's deep link names it. */
export const EDITOR_EXTENSION_ID = 'doop.doop'

/** URL schemes of the editors the extension runs in, with the name the key is given. */
const EDITORS: Record<string, string> = {
  vscode: 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  vscodium: 'VSCodium',
  'code-oss': 'Code - OSS',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  positron: 'Positron',
  kiro: 'Kiro',
  trae: 'Trae',
  antigravity: 'Antigravity',
}

const STATE_PATTERN = /^[0-9a-f]{32}$/

export interface EditorConnectRequest {
  /** the editor's deep link, checked by editorRedirect */
  redirect: string
  /** the extension's random per-attempt value, handed back unchanged */
  state: string
}

/** The editor a deep link opens, or null when it is not one of ours: a known
 *  editor scheme, this extension's authority and its /auth path, nothing else.
 *  Anything looser would let a link hand a fresh code to whatever app owns
 *  that URL. */
export function editorRedirect(raw: string): { url: URL; editor: string } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const editor = EDITORS[url.protocol.replace(/:$/, '')]
  if (!editor) return null
  if (url.hostname.toLowerCase() !== EDITOR_EXTENSION_ID || url.pathname !== '/auth') return null
  if (url.username || url.password || url.port) return null
  return { url, editor }
}

/** The page's query, or null when it is incomplete or names a redirect that is not an editor's. */
export function parseEditorConnectQuery(search: string): EditorConnectRequest | null {
  const query = new URLSearchParams(search)
  const redirect = query.get('redirect') ?? ''
  const state = query.get('state') ?? ''
  if (!STATE_PATTERN.test(state) || !editorRedirect(redirect)) return null
  return { redirect, state }
}

/** The deep link the browser follows once the code is minted: the editor's own,
 *  whatever query it carries (VS Code's `windowId`) kept, plus `code` and `state`. */
export function editorCallbackURL(request: EditorConnectRequest, code: string): string {
  const target = editorRedirect(request.redirect)
  if (!target) throw new Error('not an editor redirect')
  const url = new URL(target.url.href)
  url.searchParams.set('code', code)
  url.searchParams.set('state', request.state)
  return url.href
}

/** A same-origin path to land on after the embed, or null. */
export function embedTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  try {
    const base = 'http://doop.invalid'
    const url = new URL(raw, base)
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : null
  } catch {
    return null
  }
}
