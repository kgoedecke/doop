import type { ComponentDef } from './components.ts'

/** Public metadata only; registry source is fetched and validated on the server. */
export interface RegistryItemSummary {
  name: string
  title: string
  description: string
  type: string
  /** the registry index or item JSON this item is read from */
  source: string
}

export interface RegistryPreview {
  name: string
  /** the registry's namespace in the shadcn directory, `@magicui`, when known */
  namespace?: string
  homepage?: string
  items: RegistryItemSummary[]
}

/** One public registry from the shadcn directory (`ui.shadcn.com/r/registries.json`). */
export interface RegistryDirectoryEntry {
  namespace: string
  homepage: string
  description: string
  featured: boolean
}

export interface RegistrySelection {
  source: string
  name: string
}

export interface RegistryImportResult {
  components: ComponentDef[]
  failures: { name: string; error: string }[]
  /** shadcn variables now read from this canvas's tokens, `--primary` → `--color-brand` */
  themed: { variable: string; token: string }[]
}

/** Item types that render to something a designer can place. */
export const RENDERABLE_REGISTRY_TYPES = new Set([
  'registry:ui',
  'registry:component',
  'registry:block',
  'registry:example',
  'registry:page',
])

const SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*|[a-zA-Z0-9][a-zA-Z0-9._-]*|https?:\/\/\S+)$/
const ADD_COMMAND =
  /(?:^|\s)(?:npx|pnpm\s+dlx|bunx(?:\s+--bun)?|yarn(?:\s+dlx)?)\s+shadcn(?:-ui)?(?:@[\w.-]+)?\s+add\s+([^\n]+)/i

/** What someone pasted, as registry specs: a URL, `@namespace/item`, a bare
 *  official item name, or an `npx shadcn add …` command naming any of those.
 *  Null when the text is none of them, so a paste can fall through. */
export function registrySpecs(text: string): string[] | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 4000) return null
  const command = ADD_COMMAND.exec(trimmed)
  const words = (command ? command[1]! : trimmed)
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ''))
    .filter((word) => word && !word.startsWith('-'))
  if (!words.length || words.length > 20 || !words.every((word) => SPEC.test(word))) return null
  /* a lone bare word is only a registry item inside a command */
  if (!command && words.some((word) => !word.includes('/') && !word.includes(':'))) return null
  return words
}

/** Whether a paste on the canvas is clearly meant for the registry importer:
 *  an install command, an `@namespace/item`, or a registry JSON URL. A plain
 *  web address is left alone. */
export function isRegistryPaste(text: string): boolean {
  const specs = registrySpecs(text)
  if (!specs) return false
  return (
    ADD_COMMAND.test(text) ||
    specs.every((spec) => spec.startsWith('@') || /^https?:\/\/[^\s]+\/r\/[^\s]+\.json$/i.test(spec))
  )
}
