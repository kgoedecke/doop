import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { store } from './store.ts'
import { canEditCanvas } from './access.ts'
import { isWorkspaceMember } from './workspaces.ts'
import {
  COMPONENT_SLUG_RE,
  DEFAULT_GLOBAL_CSS,
  MAX_COMPONENTS,
  MAX_COMPONENT_CSS_CHARS,
  MAX_COMPONENT_HTML_CHARS,
  MAX_COMPONENT_JS_CHARS,
  MAX_COMPONENT_VARIANTS,
  MAX_CUSTOM_GROUPS,
  MAX_DESCRIPTION_CHARS,
  MAX_GLOBAL_CSS_CHARS,
  MAX_NAME_CHARS,
  MAX_NOTES_CHARS,
  PRESET_GROUPS,
  cssTokens,
  ensureInstanceAttribute,
  ensureInstanceName,
  isPresetGroup,
  libraryScopeOf,
  slugify,
} from '../shared/designSystem.ts'
import type {
  ComponentGroup,
  ComponentVariant,
  DesignSystemStyles,
  LibraryComponent,
  LibraryScope,
  LibrarySnapshot,
  StampSource,
} from '../shared/designSystem.ts'
import type { Canvas } from '../shared/types.ts'

/**
 * Component libraries (shared/designSystem.ts): the global stylesheet,
 * custom groups and components of every scope, held in memory — every frame
 * write stamps from here — and written through to the database the way
 * workspaces.ts does it.
 */

interface CustomGroup {
  id: string
  name: string
  description?: string
  createdAt: number
}

const stylesByScope = new Map<LibraryScope, DesignSystemStyles>()
const groupsByScope = new Map<LibraryScope, CustomGroup[]>()
/** scope -> slug -> component */
const componentsByScope = new Map<LibraryScope, Map<string, LibraryComponent>>()

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[library] write failed', err))
}

function isScope(value: string): value is LibraryScope {
  return /^(workspace|user|canvas):.+/.test(value)
}

function componentsOf(scope: LibraryScope): Map<string, LibraryComponent> {
  let map = componentsByScope.get(scope)
  if (!map) componentsByScope.set(scope, (map = new Map()))
  return map
}

export async function hydrateLibrary(): Promise<void> {
  const [styleRows, groupRows, componentRows] = await Promise.all([
    db.select().from(t.designSystems),
    db.select().from(t.componentGroups),
    db.select().from(t.libraryComponents),
  ])
  stylesByScope.clear()
  groupsByScope.clear()
  componentsByScope.clear()
  for (const row of styleRows) {
    if (!isScope(row.scope)) continue
    stylesByScope.set(row.scope, {
      globalCss: row.globalCss,
      notes: row.notes,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    })
  }
  for (const row of groupRows) {
    if (!isScope(row.scope)) continue
    const list = groupsByScope.get(row.scope) ?? []
    list.push({ id: row.id, name: row.name, description: row.description ?? undefined, createdAt: row.createdAt })
    groupsByScope.set(row.scope, list)
  }
  for (const list of groupsByScope.values()) list.sort((a, b) => a.createdAt - b.createdAt)
  for (const row of componentRows) {
    if (!isScope(row.scope)) continue
    componentsOf(row.scope).set(row.slug, {
      id: row.id,
      slug: row.slug,
      name: row.name,
      groupId: row.groupId,
      kind: row.kind ?? undefined,
      description: row.description,
      html: row.html,
      css: row.css,
      js: row.js,
      variants: row.variants ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    })
  }
}

/* ---- access ---- */

function splitScope(scope: LibraryScope): [string, string] {
  const at = scope.indexOf(':')
  return [scope.slice(0, at), scope.slice(at + 1)]
}

/** May this user change the library of `scope`? A team library is its
 *  workspace members'; a personal one only its owner's, never a share-link
 *  visitor's; an unowned canvas's library follows that canvas's edit role. */
export function canEditLibrary(userId: string | undefined, scope: LibraryScope): boolean {
  const [kind, id] = splitScope(scope)
  if (kind === 'workspace') return isWorkspaceMember(id, userId)
  if (kind === 'user') return !!userId && userId === id
  const canvas = store.getCanvas(id)
  return !!canvas && canEditCanvas(userId, canvas)
}

export function scopeOfCanvas(canvasId: string): LibraryScope | undefined {
  const canvas = store.getCanvas(canvasId)
  return canvas ? libraryScopeOf(canvas) : undefined
}

export function canvasesInScope(scope: LibraryScope): Canvas[] {
  return store.allCanvases().filter((canvas) => libraryScopeOf(canvas) === scope)
}

/* ---- reads ---- */

export function isInitialized(scope: LibraryScope): boolean {
  return stylesByScope.has(scope)
}

export function stylesOf(scope: LibraryScope): DesignSystemStyles {
  return stylesByScope.get(scope) ?? { globalCss: DEFAULT_GLOBAL_CSS, notes: '', updatedAt: 0, updatedBy: '' }
}

export function groupsOf(scope: LibraryScope): ComponentGroup[] {
  const custom = (groupsByScope.get(scope) ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    preset: false,
    kinds: [] as string[],
  }))
  return [...PRESET_GROUPS.map((group) => ({ ...group, preset: true })), ...custom]
}

export function listComponents(scope: LibraryScope): LibraryComponent[] {
  return [...componentsOf(scope).values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function findComponent(scope: LibraryScope, idOrSlug: string): LibraryComponent | undefined {
  const map = componentsOf(scope)
  return map.get(idOrSlug) ?? [...map.values()].find((component) => component.id === idOrSlug)
}

export function snapshot(scope: LibraryScope, canEdit: boolean): LibrarySnapshot {
  return {
    scope,
    initialized: isInitialized(scope),
    styles: stylesOf(scope),
    groups: groupsOf(scope),
    components: listComponents(scope),
    canEdit,
  }
}

export function stampSource(scope: LibraryScope): StampSource {
  return { initialized: isInitialized(scope), globalCss: stylesOf(scope).globalCss, components: componentsOf(scope) }
}

/** The catalogue an agent designs from: tokens, rules and every component
 *  with the markup that places it. Empty when the scope has no library. */
export function designSystemBrief(scope: LibraryScope): string {
  if (!isInitialized(scope)) return ''
  const styles = stylesOf(scope)
  const tokens = cssTokens(styles.globalCss)
  const groupName = new Map(groupsOf(scope).map((group) => [group.id, group.name]))
  const lines = [
    '# Design system',
    'This canvas has a component library. Build screens from it: place a component by writing its markup, keeping `data-doop-component="<slug>"` and its `data-name` on its root — Doop stamps the component CSS/JS and the global stylesheet into the frame for you, so never copy their CSS. Style everything else with the tokens below (`var(--token)`), not literal values. When a tool to register components (save_component) is available, register a new reusable piece with it instead of repeating it.',
  ]
  if (tokens.length) lines.push('', '## Tokens', ...tokens.map((token) => `- ${token.name}: ${token.value}`))
  if (styles.notes.trim()) lines.push('', '## Usage rules', styles.notes.trim())
  const components = listComponents(scope)
  if (components.length) {
    lines.push('', '## Components')
    for (const component of components) {
      const where = groupName.get(component.groupId) ?? component.groupId
      const about = component.description ? ` — ${component.description}` : ''
      lines.push(`### ${component.name} (\`${component.slug}\`, ${where})${about}`, '```html', component.html, '```')
      for (const variant of component.variants) lines.push(`${variant.name}:`, '```html', variant.html, '```')
    }
  }
  return lines.join('\n')
}

/* ---- writes ---- */

function persistStyles(scope: LibraryScope, styles: DesignSystemStyles) {
  const row = {
    globalCss: styles.globalCss,
    notes: styles.notes,
    updatedAt: styles.updatedAt,
    updatedBy: styles.updatedBy,
  }
  swallow(
    db
      .insert(t.designSystems)
      .values({ scope, ...row })
      .onConflictDoUpdate({ target: t.designSystems.scope, set: row }),
  )
}

/** The library's first write makes the suggested stylesheet real, so the
 *  components that land with it have tokens to read. */
function ensureInitialized(scope: LibraryScope, by: string) {
  if (isInitialized(scope)) return
  const styles = { globalCss: DEFAULT_GLOBAL_CSS, notes: '', updatedAt: Date.now(), updatedBy: by }
  stylesByScope.set(scope, styles)
  persistStyles(scope, styles)
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new LibraryError(`${field} must be text`)
  if (value.length > max) throw new LibraryError(`${field} is longer than ${max} characters`)
  return value
}

export function saveStyles(
  scope: LibraryScope,
  patch: { globalCss?: unknown; notes?: unknown },
  by: string,
): DesignSystemStyles {
  const current = stylesOf(scope)
  const styles: DesignSystemStyles = {
    globalCss:
      patch.globalCss === undefined ? current.globalCss : text(patch.globalCss, 'globalCss', MAX_GLOBAL_CSS_CHARS),
    notes: patch.notes === undefined ? current.notes : text(patch.notes, 'notes', MAX_NOTES_CHARS),
    updatedAt: Date.now(),
    updatedBy: by,
  }
  stylesByScope.set(scope, styles)
  persistStyles(scope, styles)
  return styles
}

function displayName(value: unknown): string {
  const name = text(value, 'name', MAX_NAME_CHARS).trim()
  if (!name) throw new LibraryError('name required')
  return name
}

export function createGroup(scope: LibraryScope, input: { name?: unknown; description?: unknown }): ComponentGroup {
  const list = groupsByScope.get(scope) ?? []
  if (list.length >= MAX_CUSTOM_GROUPS)
    throw new LibraryError(`A library holds at most ${MAX_CUSTOM_GROUPS} custom groups`)
  const group: CustomGroup = {
    id: `g_${nanoid(10)}`,
    name: displayName(input.name),
    description: input.description ? text(input.description, 'description', MAX_DESCRIPTION_CHARS).trim() : undefined,
    createdAt: Date.now(),
  }
  groupsByScope.set(scope, [...list, group])
  swallow(db.insert(t.componentGroups).values({ ...group, scope, description: group.description ?? null }))
  return groupsOf(scope).find((g) => g.id === group.id)!
}

export function updateGroup(
  scope: LibraryScope,
  id: string,
  patch: { name?: unknown; description?: unknown },
): ComponentGroup {
  const group = groupsByScope.get(scope)?.find((g) => g.id === id)
  if (!group) throw new LibraryError(isPresetGroup(id) ? 'preset groups cannot be changed' : 'group not found', 404)
  if (patch.name !== undefined) group.name = displayName(patch.name)
  if (patch.description !== undefined)
    group.description = text(patch.description, 'description', MAX_DESCRIPTION_CHARS).trim() || undefined
  swallow(
    db
      .update(t.componentGroups)
      .set({ name: group.name, description: group.description ?? null })
      .where(eq(t.componentGroups.id, id)),
  )
  return groupsOf(scope).find((g) => g.id === id)!
}

/** Deletes an empty custom group; its components have to move out first. */
export function deleteGroup(scope: LibraryScope, id: string): void {
  const list = groupsByScope.get(scope) ?? []
  if (!list.some((g) => g.id === id)) throw new LibraryError('group not found', 404)
  if (listComponents(scope).some((component) => component.groupId === id))
    throw new LibraryError('move or delete the components of this group first', 409)
  groupsByScope.set(
    scope,
    list.filter((g) => g.id !== id),
  )
  swallow(db.delete(t.componentGroups).where(eq(t.componentGroups.id, id)))
}

export interface ComponentInput {
  name?: unknown
  slug?: unknown
  groupId?: unknown
  kind?: unknown
  description?: unknown
  html?: unknown
  css?: unknown
  js?: unknown
  variants?: unknown
}

/** Marks markup as an instance of the component and names its layer, so a
 *  renamed component's markup follows the new name. */
function instanceMarkup(html: string, slug: string, name: string, previousName?: string): string {
  const marked = ensureInstanceAttribute(html, slug)
  const renamed =
    previousName && previousName !== name
      ? marked.replace(`data-name="${escapeAttr(previousName)}"`, `data-name="${escapeAttr(name)}"`)
      : marked
  return ensureInstanceName(renamed, slug, name)
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function variantsOf(value: unknown, slug: string): ComponentVariant[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new LibraryError('variants must be a list')
  if (value.length > MAX_COMPONENT_VARIANTS)
    throw new LibraryError(`a component holds at most ${MAX_COMPONENT_VARIANTS} variants`)
  return value.map((raw: unknown, i) => {
    const entry = (raw ?? {}) as { name?: unknown; html?: unknown }
    const name = text(entry.name ?? `Variant ${i + 1}`, 'variant name', MAX_NAME_CHARS).trim() || `Variant ${i + 1}`
    const html = text(entry.html, 'variant html', MAX_COMPONENT_HTML_CHARS).trim()
    if (!html) throw new LibraryError(`variant "${name}" needs markup`)
    return { name, html: ensureInstanceAttribute(html, slug) }
  })
}

/**
 * Creates a component, or updates the one `id` names (a partial update
 * keeps the fields it leaves out). Returns the component and, when the slug
 * changed, the slug its frames still name.
 */
export function saveComponent(
  scope: LibraryScope,
  input: ComponentInput,
  by: string,
  id?: string,
): { component: LibraryComponent; renamedFrom?: string } {
  const map = componentsOf(scope)
  const existing = id ? findComponent(scope, id) : undefined
  if (id && !existing) throw new LibraryError('component not found', 404)
  if (!existing && map.size >= MAX_COMPONENTS)
    throw new LibraryError(`A library holds at most ${MAX_COMPONENTS} components`)

  const name = input.name === undefined && existing ? existing.name : displayName(input.name)
  const slug =
    input.slug === undefined || input.slug === ''
      ? (existing?.slug ?? slugify(name))
      : text(input.slug, 'slug', 64).trim().toLowerCase()
  if (!COMPONENT_SLUG_RE.test(slug))
    throw new LibraryError('slug must start with a letter and use only a-z, 0-9 and hyphens')
  const clash = map.get(slug)
  if (clash && clash.id !== existing?.id) throw new LibraryError(`a component named "${slug}" already exists`, 409)

  const groupId =
    input.groupId === undefined && existing ? existing.groupId : text(input.groupId ?? '', 'groupId', 64).trim()
  if (!isPresetGroup(groupId) && !groupsByScope.get(scope)?.some((g) => g.id === groupId))
    throw new LibraryError('pick a group for the component')

  const kind =
    input.kind === undefined ? existing?.kind : text(input.kind ?? '', 'kind', MAX_NAME_CHARS).trim() || undefined
  const html =
    input.html === undefined && existing ? existing.html : text(input.html, 'html', MAX_COMPONENT_HTML_CHARS).trim()
  if (!html) throw new LibraryError('a component needs markup')
  const pick = (value: unknown, fallback: string, field: string, max: number) =>
    value === undefined ? fallback : text(value ?? '', field, max)

  const now = Date.now()
  const component: LibraryComponent = {
    id: existing?.id ?? `cmp_${nanoid(12)}`,
    slug,
    name,
    groupId,
    ...(kind ? { kind } : {}),
    description: pick(input.description, existing?.description ?? '', 'description', MAX_DESCRIPTION_CHARS).trim(),
    html: instanceMarkup(html, slug, name, existing?.name),
    css: pick(input.css, existing?.css ?? '', 'css', MAX_COMPONENT_CSS_CHARS),
    js: pick(input.js, existing?.js ?? '', 'js', MAX_COMPONENT_JS_CHARS),
    variants: (input.variants === undefined && existing ? existing.variants : variantsOf(input.variants, slug)).map(
      (variant) => ({ ...variant, html: instanceMarkup(variant.html, slug, name, existing?.name) }),
    ),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    updatedBy: by,
  }

  ensureInitialized(scope, by)
  if (existing && existing.slug !== slug) map.delete(existing.slug)
  map.set(slug, component)
  const row = {
    slug,
    name,
    groupId,
    kind: component.kind ?? null,
    description: component.description,
    html: component.html,
    css: component.css,
    js: component.js,
    variants: component.variants,
    updatedAt: now,
    updatedBy: by,
  }
  swallow(
    db
      .insert(t.libraryComponents)
      .values({ id: component.id, scope, createdAt: component.createdAt, ...row })
      .onConflictDoUpdate({ target: t.libraryComponents.id, set: row }),
  )
  return { component, ...(existing && existing.slug !== slug ? { renamedFrom: existing.slug } : {}) }
}

export function deleteComponent(scope: LibraryScope, idOrSlug: string): LibraryComponent {
  const component = findComponent(scope, idOrSlug)
  if (!component) throw new LibraryError('component not found', 404)
  componentsOf(scope).delete(component.slug)
  swallow(db.delete(t.libraryComponents).where(eq(t.libraryComponents.id, component.id)))
  return component
}
