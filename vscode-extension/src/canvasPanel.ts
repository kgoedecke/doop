import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { EDITOR_EMBED_PATH } from '../../shared/editorConnect.ts'
import type { Auth, EmbedTicket } from './auth.ts'
import { serverUrl } from './server.ts'

/* A canvas, live, in an editor tab: the Doop app itself in an iframe inside a
   webview, so it is the same multiplayer canvas as in the browser (cursors,
   agents streaming frames in, comments), not a copy. The iframe first loads
   /editor/embed with a one-minute ticket, which signs that one view in
   (server/editorConnect.ts explains the partitioned cookie) and lands on the
   canvas. */

export const VIEW_TYPE = 'doop.canvas'

export interface CanvasRef {
  id: string
  name: string
}

/** What a tab keeps across reloads: the canvas and the server it is on. */
interface PanelState extends CanvasRef {
  server?: string
}

/** A server the view cannot sign in to: the embed cookie is Secure, which a browser keeps only over
 *  https or on this machine. */
function insecure(origin: string): boolean {
  const url = new URL(origin)
  return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export class CanvasPanels implements vscode.WebviewPanelSerializer<PanelState> {
  private readonly open = new Map<string, { panel: vscode.WebviewPanel; canvas: CanvasRef }>()
  private active: CanvasRef | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: Auth,
  ) {}

  /** The canvas in the focused Doop tab, if one is focused. */
  activeCanvas(): CanvasRef | undefined {
    return this.active
  }

  async show(canvas: CanvasRef, column: vscode.ViewColumn = vscode.ViewColumn.Active): Promise<void> {
    const existing = this.open.get(canvas.id)
    if (existing) {
      existing.panel.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, canvas.name, column, this.options())
    await this.attach(panel, canvas)
  }

  /** VS Code restoring a Doop tab after a reload: a fresh ticket, the same canvas. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined): Promise<void> {
    /* a canvas id means nothing on another server */
    if (!state?.id || (state.server && state.server !== serverUrl())) {
      panel.dispose()
      return
    }
    panel.webview.options = this.options()
    await this.attach(panel, state)
  }

  async reload(canvasId?: string): Promise<void> {
    const entry = this.open.get(canvasId ?? this.active?.id ?? '')
    if (entry) await this.render(entry.panel, entry.canvas)
  }

  /** The server setting changed: these canvases are on the old one. */
  closeAll(): void {
    for (const { panel } of [...this.open.values()]) panel.dispose()
  }

  async reloadAll(): Promise<void> {
    await Promise.all([...this.open.values()].map(({ panel, canvas }) => this.render(panel, canvas)))
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
  }

  private async attach(panel: vscode.WebviewPanel, canvas: CanvasRef): Promise<void> {
    this.open.set(canvas.id, { panel, canvas })
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'doop.svg')
    panel.title = canvas.name
    if (panel.active) this.active = canvas
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) this.active = canvas
      else if (this.active?.id === canvas.id) this.active = undefined
    })
    panel.onDidDispose(() => {
      this.open.delete(canvas.id)
      if (this.active?.id === canvas.id) this.active = undefined
    })
    panel.webview.onDidReceiveMessage((message: { type?: string; title?: string }) => {
      if (message.type === 'signIn') void vscode.commands.executeCommand('doop.signIn')
      if (message.type === 'retry') void this.render(panel, canvas)
    })
    await this.render(panel, canvas)
  }

  private async render(panel: vscode.WebviewPanel, canvas: CanvasRef): Promise<void> {
    const origin = serverUrl()
    const answer: EmbedTicket = await this.auth.embedTicket()
    const ticket = 'ticket' in answer ? answer.ticket : null
    const target = `/c/${encodeURIComponent(canvas.id)}`
    const src = ticket
      ? `${origin}${EDITOR_EMBED_PATH}?${new URLSearchParams({ ticket, to: target })}`
      : `${origin}${target}`
    const nonce = randomBytes(16).toString('base64')
    panel.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(canvas.name)}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: transparent; }
  .bar { position: fixed; left: 12px; right: 12px; bottom: 12px; display: none; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: 8px; font: 12px var(--vscode-font-family);
    color: var(--vscode-notifications-foreground); background: var(--vscode-notifications-background);
    box-shadow: 0 2px 10px rgba(0,0,0,.25); }
  .bar.show { display: flex; }
  .bar button { margin-left: auto; font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
</style>
</head>
<body>
<iframe src="${escape(src)}" title="${escape(canvas.name)}" allow="clipboard-read; clipboard-write; fullscreen; web-share"></iframe>
${bar(answer, origin)}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.setState(${JSON.stringify({ id: canvas.id, name: canvas.name, server: origin }).replace(/</g, '\\u003c')});
  document.getElementById('signin')?.addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
  document.getElementById('retry')?.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
</script>
</body>
</html>`
  }
}

/** The note under the canvas when the view is not signed in the ordinary way. */
function bar(answer: EmbedTicket, origin: string): string {
  if ('error' in answer)
    return `<div class="bar show">Could not reach ${escape(new URL(origin).host)}: ${escape(answer.error)}<button id="retry">Retry</button></div>`
  if ('signedOut' in answer)
    return `<div class="bar show">Not signed in to Doop: only canvases shared by link open here.<button id="signin">Sign in</button></div>`
  if (insecure(origin))
    return `<div class="bar show">${escape(new URL(origin).host)} is served over plain http, so this view cannot stay signed in. Serve Doop over https, or open the canvas in your browser.</div>`
  return ''
}
