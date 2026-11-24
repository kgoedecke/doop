import * as vscode from 'vscode'
import { agentPrompt, connectAgents, DoopMcpProvider } from './agents.ts'
import { Auth } from './auth.ts'
import { CanvasPanels, VIEW_TYPE, type CanvasRef } from './canvasPanel.ts'
import { CanvasTree, type CanvasInfo } from './canvases.ts'
import { callTool, canvasIdFrom, canvasUrl, serverUrl } from './server.ts'

/* Doop in the editor, modelled on how pen.dev sits in VS Code, but online:
   the activity bar lists the account's canvases, a canvas opens as a tab
   showing the live Doop app, and the coding agents in and around the editor
   get Doop's MCP server signed in as the same person, so what they design
   streams into that tab as they work. */

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Doop', { log: true })
  const auth = new Auth(context, log)
  const tree = new CanvasTree(auth)
  const panels = new CanvasPanels(context, auth)
  const mcp = new DoopMcpProvider(auth)

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  status.name = 'Doop'

  const sync = async () => {
    const signedIn = await auth.signedIn()
    await vscode.commands.executeCommand('setContext', 'doop.signedIn', signedIn)
    const user = auth.user()
    status.text = signedIn ? '$(layout) Doop' : '$(layout) Doop: sign in'
    status.tooltip = signedIn
      ? `Signed in to ${new URL(serverUrl()).host}${user ? ` as ${user.email}` : ''}`
      : `Sign in to ${new URL(serverUrl()).host}`
    status.command = signedIn ? 'doop.openCanvas' : 'doop.signIn'
    status.show()
    tree.refresh()
  }

  /* An item from the tree, a CanvasRef from a command, or the focused Doop tab. */
  const canvasOf = (arg: unknown): CanvasRef | undefined => {
    if (arg && typeof arg === 'object') {
      const value = arg as { id?: unknown; name?: unknown; canvas?: CanvasInfo }
      if (value.canvas) return { id: value.canvas.id, name: value.canvas.name }
      if (typeof value.id === 'string')
        return { id: value.id, name: typeof value.name === 'string' ? value.name : value.id }
    }
    return panels.activeCanvas()
  }

  const pickCanvas = async (): Promise<CanvasRef | undefined> => {
    const loading = tree.list().length ? Promise.resolve(tree.list()) : tree.load()
    type Item = vscode.QuickPickItem & { canvas?: CanvasInfo }
    const pick = await vscode.window.showQuickPick<Item>(
      loading.then((canvases): Item[] => [
        { label: '$(add) New canvas…' },
        ...canvases.map((canvas) => ({
          label: canvas.name,
          description: canvas.workspace_name ?? (canvas.shared ? 'shared with you' : ''),
          canvas,
        })),
      ]),
      { title: 'Open a Doop canvas', placeHolder: 'Search your canvases', matchOnDescription: true },
    )
    if (!pick) return undefined
    if (!pick.canvas) return newCanvas()
    return { id: pick.canvas.id, name: pick.canvas.name }
  }

  const newCanvas = async (): Promise<CanvasRef | undefined> => {
    const key = await auth.key()
    if (!key) return void vscode.window.showWarningMessage('Doop: sign in first.')
    const name = await vscode.window.showInputBox({
      title: 'New Doop canvas',
      prompt: 'Name the canvas',
      value: vscode.workspace.name ?? '',
      validateInput: (value) => (value.trim() ? null : 'Give it a name'),
    })
    if (!name) return undefined
    try {
      const canvas = await callTool<{ id: string; name: string }>(key, 'create_canvas', { name: name.trim() })
      tree.refresh()
      return { id: canvas.id, name: canvas.name }
    } catch (err) {
      void vscode.window.showErrorMessage(`Doop: could not create the canvas. ${(err as Error).message}`)
      return undefined
    }
  }

  const command = (id: string, run: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, run))

  command('doop.signIn', () => auth.signIn())
  command('doop.useAgentKey', () => auth.useAgentKey())
  command('doop.signOut', async () => {
    await auth.signOut()
    void vscode.window.showInformationMessage(
      "Doop: signed out. The editor's agent key was removed, so agents you connected with it are signed out too.",
    )
  })
  command('doop.refresh', () => tree.refresh())
  command('doop.newCanvas', async () => {
    const canvas = await newCanvas()
    if (canvas) await panels.show(canvas)
  })
  command('doop.openCanvas', async (arg) => {
    const canvas = arg ? canvasOf(arg) : await pickCanvas()
    if (canvas) await panels.show(canvas)
  })
  command('doop.openCanvasUrl', async () => {
    const input = await vscode.window.showInputBox({
      title: 'Open a Doop canvas',
      prompt: 'Paste a canvas link',
      placeHolder: `${serverUrl()}/c/…`,
      validateInput: (value) => (canvasIdFrom(value) ? null : 'Not a Doop canvas link'),
    })
    const id = input ? canvasIdFrom(input) : null
    if (!id) return
    const known = tree.list().find((canvas) => canvas.id === id)
    await panels.show({ id, name: known?.name ?? 'Doop canvas' })
  })
  command('doop.openInBrowser', (arg) => {
    const canvas = canvasOf(arg)
    if (canvas) void vscode.env.openExternal(vscode.Uri.parse(canvasUrl(canvas.id)))
  })
  command('doop.openDoop', () => vscode.env.openExternal(vscode.Uri.parse(serverUrl())))
  command('doop.copyLink', async (arg) => {
    const canvas = canvasOf(arg)
    if (!canvas) return
    await vscode.env.clipboard.writeText(canvasUrl(canvas.id))
    void vscode.window.setStatusBarMessage('Doop: link copied', 2500)
  })
  command('doop.copyAgentPrompt', async (arg) => {
    const canvas = canvasOf(arg)
    if (!canvas) return
    await vscode.env.clipboard.writeText(agentPrompt(canvas))
    void vscode.window.showInformationMessage(
      'Doop: a prompt naming this canvas is on your clipboard. Paste it into your agent and finish the sentence.',
    )
  })
  command('doop.reloadCanvas', () => panels.reload())
  command('doop.connectAgents', () => connectAgents(auth))

  context.subscriptions.push(
    log,
    status,
    vscode.window.registerUriHandler(auth),
    vscode.window.registerTreeDataProvider('doop.canvases', tree),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, panels),
    vscode.lm.registerMcpServerDefinitionProvider('doop.mcp', mcp),
    auth.onDidChange(() => {
      void sync()
      void panels.reloadAll()
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('doop.serverUrl')) {
        panels.closeAll()
        auth.serverChanged()
      }
      if (event.affectsConfiguration('doop.registerMcpServer')) mcp.refresh()
    }),
  )
  void sync()
}

export function deactivate(): void {}
