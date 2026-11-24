import * as vscode from 'vscode'
import type { Auth } from './auth.ts'
import { callTool, canvasUrl } from './server.ts'

/* The sidebar: the account's canvases, read live from the server (MCP
   list_canvases) every time it is shown or refreshed. Nothing is kept in the
   workspace: a canvas is opened by its id. */

export interface CanvasInfo {
  id: string
  name: string
  updatedAt?: number
  shared?: boolean
  workspace_id?: string
  workspace_name?: string
}

type Node = { kind: 'group'; label: string; canvases: CanvasInfo[] } | { kind: 'canvas'; canvas: CanvasInfo }

const PERSONAL = 'Personal'
const SHARED = 'Shared with you'

function ago(ms: number | undefined): string {
  if (!ms) return ''
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString()
}

export class CanvasTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private canvases: CanvasInfo[] = []

  constructor(private readonly auth: Auth) {}

  refresh(): void {
    this.changed.fire(undefined)
  }

  /** The canvases last listed, newest first. */
  list(): CanvasInfo[] {
    return this.canvases
  }

  async load(): Promise<CanvasInfo[]> {
    const key = await this.auth.key()
    if (!key) return (this.canvases = [])
    const canvases = await callTool<CanvasInfo[]>(key, 'list_canvases')
    this.canvases = [...(Array.isArray(canvases) ? canvases : [])].sort(
      (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    )
    return this.canvases
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded)
      item.contextValue = 'group'
      return item
    }
    const { canvas } = node
    const item = new vscode.TreeItem(canvas.name, vscode.TreeItemCollapsibleState.None)
    item.id = canvas.id
    item.description = ago(canvas.updatedAt)
    item.tooltip = new vscode.MarkdownString(`**${canvas.name}**\n\n${canvasUrl(canvas.id)}`)
    item.iconPath = new vscode.ThemeIcon(canvas.shared ? 'organization' : 'layout')
    item.contextValue = 'canvas'
    item.command = { command: 'doop.openCanvas', title: 'Open Canvas', arguments: [canvas] }
    return item
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node?.kind === 'group') return node.canvases.map((canvas) => ({ kind: 'canvas', canvas }))
    if (node) return []
    let canvases: CanvasInfo[]
    try {
      canvases = await this.load()
    } catch (err) {
      void vscode.window.showErrorMessage(`Doop: could not list canvases. ${(err as Error).message}`)
      canvases = []
    }
    void vscode.commands.executeCommand('setContext', 'doop.empty', canvases.length === 0)
    const groups = new Map<string, CanvasInfo[]>()
    for (const canvas of canvases) {
      const label = canvas.workspace_name ?? (canvas.shared ? SHARED : PERSONAL)
      groups.set(label, [...(groups.get(label) ?? []), canvas])
    }
    if (groups.size <= 1) return canvases.map((canvas) => ({ kind: 'canvas', canvas }))
    const order = (label: string) => (label === PERSONAL ? 0 : label === SHARED ? 2 : 1)
    return [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
      .map(([label, list]) => ({ kind: 'group', label, canvases: list }))
  }
}
