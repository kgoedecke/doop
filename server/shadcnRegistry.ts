import { z } from 'zod'
import { fetchPinnedPublicUrl, parsePublicHttpUrl } from './publicUrl.ts'
import {
  RENDERABLE_REGISTRY_TYPES,
  registrySpecs,
  type RegistryDirectoryEntry,
  type RegistryItemSummary,
  type RegistryPreview,
  type RegistrySelection,
} from '../shared/shadcnRegistry.ts'

const MAX_ITEM_BYTES = 2_000_000
/* community indexes inline every item's source (reui's is 2.5 MB) */
const MAX_INDEX_BYTES = 8_000_000
const MAX_PAGE_BYTES = 3_000_000
const MAX_SOURCE_CHARS = 160_000
const MAX_RESOLVED_ITEMS = 40
const MAX_PREVIEW_SPECS = 20
export const MAX_REGISTRY_SELECTION = 20

/** The shadcn CLI's public namespace directory: `@magicui` → its item URL template. */
export const DIRECTORY_URL = 'https://ui.shadcn.com/r/registries.json'
const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000
/** The official registry, which the directory leaves out because the CLI knows it by heart. */
const OFFICIAL: DirectoryRecord = {
  namespace: '@shadcn',
  homepage: 'https://ui.shadcn.com',
  description: 'The official shadcn/ui components: buttons, cards, forms, dialogs and more.',
  featured: true,
  template: 'https://ui.shadcn.com/r/styles/new-york-v4/{name}.json',
  rank: Infinity,
}
/** Shown first in the library, in this order; the rest follow by the directory's ranking. */
const FEATURED = ['@shadcn', '@magicui', '@aceternity', '@animate-ui', '@kibo-ui', '@coss', '@diceui', '@reui']
/* `{style}` is the consuming project's style; registries that need it publish these */
const STYLES = ['new-york-v4', 'new-york', 'default']

const itemSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    type: z.string().startsWith('registry:'),
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(500),
            content: z.string().optional(),
            type: z.string().optional(),
            target: z.string().optional(),
          })
          .passthrough(),
      )
      .max(100)
      .optional(),
    registryDependencies: z.array(z.string().max(2000)).max(40).optional(),
  })
  .passthrough()
const indexSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  homepage: z.string().max(500).optional(),
  items: z.array(itemSchema).min(1).max(5000),
})
const directorySchema = z.array(
  z
    .object({
      name: z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/),
      homepage: z.string().max(500).optional(),
      url: z.string().max(500),
      description: z.string().max(1000).optional(),
      health: z.object({ hidden: z.boolean().optional(), status: z.string().optional() }).passthrough().optional(),
      ranking: z.object({ score: z.number().optional() }).passthrough().optional(),
    })
    .passthrough(),
)
export type RegistryItem = z.infer<typeof itemSchema>

interface DirectoryRecord extends RegistryDirectoryEntry {
  template: string
  rank: number
}

/** A registry read once: its items, and how to reach one item's own JSON. */
interface Registry {
  url: string
  name: string
  namespace?: string
  homepage?: string
  items: RegistryItem[]
  index: boolean
  itemUrl: (name: string) => string
}

export class RegistryInputError extends Error {}

function registryUrl(raw: string): URL {
  if (raw.length > 2000) throw new RegistryInputError('Registry URL is too long')
  return parsePublicHttpUrl(raw)
}

/** GET a public URL, following redirects one hop at a time so every hop is
 *  re-checked as public, and reading at most `maxBytes`. */
async function fetchBody(
  raw: string,
  signal: AbortSignal,
  maxBytes: number,
  accept = 'application/json',
): Promise<{ url: string; type: string; text: string }> {
  let url = registryUrl(raw)
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetchPinnedPublicUrl(url, { signal, redirect: 'manual', headers: { Accept: accept } })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('Registry redirect has no destination')
      url = registryUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Could not fetch ${url.hostname}${url.pathname} (${response.status})`)
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel()
      throw new Error('Registry response is too large')
    }
    if (!response.body) throw new Error('Registry returned an empty response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw new Error('Registry response is too large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return {
      url: url.href,
      type: response.headers.get('content-type') ?? '',
      text: Buffer.concat(chunks).toString('utf8'),
    }
  }
  throw new Error('Too many registry redirects')
}

/* Registry JSON read in the last few minutes: browsing a registry's previews
   reads its index once per item, and an index can run to megabytes. */
const JSON_CACHE_MS = 10 * 60 * 1000
const JSON_CACHE_SIZE = 60
const jsonCache = new Map<string, { at: number; value: Promise<{ url: string; value: unknown }> }>()

async function fetchJson(raw: string, signal: AbortSignal, maxBytes = MAX_ITEM_BYTES) {
  const key = `${maxBytes}:${raw}`
  const known = jsonCache.get(key)
  if (known && Date.now() - known.at < JSON_CACHE_MS) return known.value
  const value = (async () => {
    const body = await fetchBody(raw, signal, maxBytes)
    try {
      return { url: body.url, value: JSON.parse(body.text) as unknown }
    } catch {
      throw new Error('The URL did not return valid registry JSON')
    }
  })()
  jsonCache.set(key, { at: Date.now(), value })
  while (jsonCache.size > JSON_CACHE_SIZE) jsonCache.delete(jsonCache.keys().next().value!)
  /* a failed read is not kept: the next request tries again */
  value.catch(() => {
    if (jsonCache.get(key)?.value === value) jsonCache.delete(key)
  })
  return value
}

/* ---------------------------------------------------------------- directory */

let directoryCache: { at: number; records: Promise<DirectoryRecord[]> } | undefined

async function loadDirectory(): Promise<DirectoryRecord[]> {
  const { value } = await fetchJson(DIRECTORY_URL, AbortSignal.timeout(20_000), 4_000_000)
  const parsed = directorySchema.parse(value)
  const records = parsed
    .filter((entry) => !entry.health?.hidden && entry.name !== OFFICIAL.namespace)
    .flatMap((entry): DirectoryRecord[] => {
      try {
        registryUrl(entry.url.replace(/\{(?:name|style)\}/g, 'x'))
      } catch {
        return []
      }
      return [
        {
          namespace: entry.name,
          homepage: entry.homepage ?? '',
          description: entry.description ?? '',
          featured: FEATURED.includes(entry.name),
          template: entry.url,
          rank: entry.ranking?.score ?? 0,
        },
      ]
    })
  return [OFFICIAL, ...records]
}

async function directory(): Promise<DirectoryRecord[]> {
  if (!directoryCache || Date.now() - directoryCache.at > DIRECTORY_TTL_MS) {
    const records = loadDirectory()
    directoryCache = { at: Date.now(), records }
    /* a failed read is not cached: the next request tries again */
    records.catch(() => {
      if (directoryCache?.records === records) directoryCache = undefined
    })
  }
  try {
    return await directoryCache.records
  } catch {
    return [OFFICIAL]
  }
}

/** The library's registry list: featured first in their fixed order, then by the directory's ranking. */
export async function registryDirectory(): Promise<RegistryDirectoryEntry[]> {
  const records = await directory()
  const featuredAt = (record: DirectoryRecord) => {
    const at = FEATURED.indexOf(record.namespace)
    return at < 0 ? FEATURED.length : at
  }
  return [...records]
    .sort((a, b) => featuredAt(a) - featuredAt(b) || b.rank - a.rank || a.namespace.localeCompare(b.namespace))
    .map(({ namespace, homepage, description, featured }) => ({ namespace, homepage, description, featured }))
}

/** Test seam: forget the cached directory and registry JSON. */
export function resetRegistryDirectory() {
  directoryCache = undefined
  jsonCache.clear()
}

async function namespaceRecord(namespace: string): Promise<DirectoryRecord> {
  const record = (await directory()).find((entry) => entry.namespace === namespace.toLowerCase())
  if (!record) throw new RegistryInputError(`${namespace} is not in the public shadcn registry directory`)
  return record
}

/** A template with its `{name}` filled; `{style}` gets each common style in turn. */
function templateUrls(template: string, name: string): string[] {
  const named = template.replace(/\{name\}/g, name)
  return named.includes('{style}') ? STYLES.map((style) => named.replace(/\{style\}/g, style)) : [named]
}

/** The directory entry whose template lives where this URL does, so an index
 *  read by URL still finds its items the way the CLI would. */
async function recordFor(url: string): Promise<DirectoryRecord | undefined> {
  const { origin, pathname } = new URL(url)
  const base = (record: DirectoryRecord) => new URL(record.template.replace(/\{(?:name|style)\}.*$/, ''))
  const records = await directory()
  const sameOrigin = records.filter((record) => base(record).origin === origin)
  /* aceternity's index is /registry.json, its items /registry/{name}.json */
  return sameOrigin.find((record) => pathname.startsWith(base(record).pathname)) ?? sameOrigin[0]
}

/* ---------------------------------------------------------------- reading */

function asRegistry(fetched: { url: string; value: unknown }, record?: DirectoryRecord): Registry {
  const index = indexSchema.safeParse(fetched.value)
  /* a style resolved for the index is the one its items use */
  const style = record?.template.includes('{style}')
    ? STYLES.find((candidate) => fetched.url.includes(`/${candidate}/`))
    : undefined
  const template = style ? record!.template.replace(/\{style\}/g, style) : record?.template
  const itemUrl = (name: string) =>
    template ? templateUrls(template, name)[0]! : new URL(`${name}.json`, fetched.url).href
  if (index.success) {
    /* real indexes repeat an entry now and then (aceternity's); the first one stands */
    const seen = new Set<string>()
    const items = index.data.items.filter((item) => !seen.has(item.name) && !!seen.add(item.name))
    return {
      url: fetched.url,
      name: index.data.name ?? record?.namespace ?? new URL(fetched.url).hostname,
      namespace: record?.namespace,
      homepage: index.data.homepage ?? record?.homepage,
      items,
      index: true,
      itemUrl,
    }
  }
  const item = itemSchema.safeParse(fetched.value)
  if (!item.success) throw new RegistryInputError('Expected a shadcn registry.json or registry item JSON URL')
  return {
    url: fetched.url,
    name: item.data.title ?? item.data.name,
    namespace: record?.namespace,
    homepage: record?.homepage,
    items: [item.data],
    index: false,
    itemUrl,
  }
}

async function readRegistry(raw: string, signal: AbortSignal): Promise<Registry> {
  const fetched = await fetchJson(raw, signal, MAX_INDEX_BYTES)
  return asRegistry(fetched, await recordFor(fetched.url))
}

/** The first of several candidate URLs that answers with registry JSON. */
async function firstRegistry(urls: string[], signal: AbortSignal, record?: DirectoryRecord): Promise<Registry> {
  let last: unknown
  for (const url of urls) {
    try {
      return asRegistry(await fetchJson(url, signal, MAX_INDEX_BYTES), record ?? (await recordFor(url)))
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new Error('Registry not found')
}

/** `@namespace` alone: that registry's whole index. */
async function namespaceIndex(namespace: string, signal: AbortSignal): Promise<Registry> {
  const record = await namespaceRecord(namespace)
  const urls = templateUrls(record.template, 'registry')
  /* a few registries publish the index beside the items, not as an item */
  const base = new URL(record.template.replace(/\{(?:name|style)\}.*$/, ''))
  urls.push(new URL('registry.json', base).href, new URL('../registry.json', base).href)
  try {
    return await firstRegistry([...new Set(urls)], signal, record)
  } catch {
    throw new RegistryInputError(`${namespace} does not publish a browsable index; paste one of its item names instead`)
  }
}

/** One spec to the URLs its item JSON may live at. */
async function specUrls(spec: string): Promise<{ urls: string[]; record?: DirectoryRecord }> {
  if (/^https?:\/\//i.test(spec)) return { urls: [registryUrl(spec).href] }
  const namespaced = /^(@[^/]+)\/(.+)$/.exec(spec)
  if (namespaced) {
    const record = await namespaceRecord(namespaced[1]!)
    return { urls: templateUrls(record.template, namespaced[2]!), record }
  }
  return { urls: templateUrls(OFFICIAL.template, spec), record: OFFICIAL }
}

const summary = (item: RegistryItem, source: string): RegistryItemSummary => ({
  name: item.name,
  title: item.title ?? item.name,
  description: item.description ?? '',
  type: item.type,
  source,
})

function previewOf(registry: Registry): RegistryPreview {
  const renderable = registry.items.filter((item) => RENDERABLE_REGISTRY_TYPES.has(item.type))
  return {
    name: registry.name,
    namespace: registry.namespace,
    homepage: registry.homepage,
    items: (renderable.length ? renderable : registry.items).map((item) => summary(item, registry.url)),
  }
}

/** Specs (`@magicui/marquee`, `card`, a URL) read one by one into a single list. */
async function previewSpecs(specs: string[], signal: AbortSignal, name: string): Promise<RegistryPreview> {
  const items: RegistryItemSummary[] = []
  let namespace: string | undefined
  let homepage: string | undefined
  const failures: string[] = []
  for (const spec of [...new Set(specs)].slice(0, MAX_PREVIEW_SPECS)) {
    try {
      const { urls, record } = await specUrls(spec)
      const registry = await firstRegistry(urls, signal, record)
      namespace ??= registry.namespace
      homepage ??= registry.homepage
      if (specs.length === 1 && registry.index) return previewOf(registry)
      for (const item of registry.items)
        if (!items.some((known) => known.name === item.name)) items.push(summary(item, registry.url))
    } catch (error) {
      failures.push(`${spec}: ${error instanceof Error ? error.message : 'not found'}`)
    }
  }
  if (!items.length) throw new RegistryInputError(failures[0] ?? 'Nothing to import was found')
  return { name: specs.length === 1 ? (items[0]?.title ?? name) : name, namespace, homepage, items }
}

/** Install commands a docs page shows, `npx shadcn@latest add @magicui/marquee`. */
function pageSpecs(html: string): string[] {
  const specs = new Set<string>()
  const text = html
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;|&#47;/g, '/')
  for (const match of text.matchAll(/shadcn(?:-ui)?(?:@[\w.-]+)?\s+add\s+([^<"\\`]{1,300})/g)) {
    for (const spec of registrySpecs(`npx shadcn add ${match[1]!.split(/[\n<]/)[0]}`) ?? []) specs.add(spec)
  }
  return [...specs]
}

/** A docs or home page: the install commands it shows, else its registry's index. */
async function previewPage(url: string, html: string, signal: AbortSignal): Promise<RegistryPreview> {
  const specs = pageSpecs(html)
  const page = new URL(url)
  if (specs.length) return previewSpecs(specs, signal, page.hostname)
  const record = (await directory()).find((entry) => {
    try {
      return (
        entry.homepage && new URL(entry.homepage).hostname.replace(/^www\./, '') === page.hostname.replace(/^www\./, '')
      )
    } catch {
      return false
    }
  })
  if (record) return previewOf(await namespaceIndex(record.namespace, signal))
  try {
    return previewOf(
      await firstRegistry([new URL('/r/registry.json', page).href, new URL('/registry.json', page).href], signal),
    )
  } catch {
    throw new RegistryInputError(
      `No shadcn registry found at ${page.hostname}. Paste its install command or a registry JSON URL.`,
    )
  }
}

/** Anything a person might paste: a registry or item JSON URL, a docs page,
 *  `@namespace` or `@namespace/item`, or an `npx shadcn add …` command. */
export async function previewRegistry(input: string): Promise<RegistryPreview> {
  const signal = AbortSignal.timeout(45_000)
  const text = input.trim()
  if (/^@[a-z0-9][a-z0-9._-]*$/i.test(text)) return previewOf(await namespaceIndex(text, signal))
  const specs = registrySpecs(text)
  if (specs && !(specs.length === 1 && /^https?:\/\//i.test(specs[0]!))) return previewSpecs(specs, signal, 'shadcn')
  let url: string
  try {
    url = registryUrl(/^https?:\/\//i.test(text) ? text : `https://${text}`).href
  } catch (error) {
    if (error instanceof RegistryInputError) throw error
    throw new RegistryInputError('Paste a registry URL, a docs page, @namespace/item or an npx shadcn add command')
  }
  const body = await fetchBody(url, signal, MAX_INDEX_BYTES, 'application/json, text/html;q=0.8')
  let value: unknown
  try {
    value = JSON.parse(body.text)
  } catch {
    if (body.text.length > MAX_PAGE_BYTES) throw new Error('That page is too large to read')
    return previewPage(body.url, body.text, signal)
  }
  return previewOf(asRegistry({ url: body.url, value }, await recordFor(body.url)))
}

/* ---------------------------------------------------------------- import */

/** Resolve the selected items and their source dependencies without installing packages. */
export async function prepareRegistryImport(selections: RegistrySelection[]) {
  if (
    !selections.length ||
    selections.length > MAX_REGISTRY_SELECTION ||
    new Set(selections.map((selection) => `${selection.source}#${selection.name}`)).size !== selections.length
  ) {
    throw new RegistryInputError(`Select between 1 and ${MAX_REGISTRY_SELECTION} distinct registry items`)
  }
  const signal = AbortSignal.timeout(45_000)
  const registries = new Map<string, Promise<Registry>>()
  const registryAt = (source: string) => {
    let registry = registries.get(source)
    if (!registry) {
      registry = readRegistry(source, signal)
      registries.set(source, registry)
    }
    return registry
  }
  const resolved = new Map<string, { url: string; item: RegistryItem }>()
  const visited = new Set<string>()
  let total = 0

  async function visit(
    registry: Registry | null,
    item: RegistryItem | null,
    url: string,
  ): Promise<RegistryItem | undefined> {
    const key = `${url}#${item?.name ?? ''}`
    if (visited.has(key)) return resolved.get(key)?.item
    visited.add(key)
    if (visited.size > MAX_RESOLVED_ITEMS) throw new Error('Too many registry dependencies; import fewer items')
    if (
      !item ||
      (!item.files && !item.cssVars && !item.css && !item.tailwind) ||
      item.files?.some((file) => file.content === undefined)
    ) {
      const fetched = await fetchJson(url, signal)
      const expectedName = item?.name
      item = itemSchema.parse(fetched.value)
      if (expectedName && item.name !== expectedName) throw new Error('Registry item name does not match its index')
      url = fetched.url
      registry ??= asRegistry(fetched, await recordFor(fetched.url))
      if (item.files?.some((file) => file.content === undefined)) {
        throw new Error(`“${item.name}” does not include file contents; use its published registry item JSON URL`)
      }
    }
    const source = JSON.stringify(item, null, 2)
    total += source.length
    if (total > MAX_SOURCE_CHARS) throw new Error('Registry source is too large; import fewer items')
    resolved.set(key, { url, item })
    for (const dependency of item.registryDependencies ?? []) {
      const local = registry?.index ? registry.items.find((candidate) => candidate.name === dependency) : undefined
      if (local && registry) {
        await visit(registry, local, registry.itemUrl(local.name))
      } else if (/^https?:\/\//i.test(dependency)) {
        await visit(null, null, registryUrl(dependency).href)
      } else if (/^@[^/]+\/.+$/.test(dependency)) {
        const { urls, record } = await specUrls(dependency)
        const found = await firstRegistry(urls, signal, record)
        await visit(found, found.items[0]!, found.url)
      } else if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(dependency)) {
        // Official styles publish the same dependency names. Keep Nova (and
        // other presets) in their own directory instead of mixing styles.
        const origin = new URL(url)
        const official = origin.origin === 'https://ui.shadcn.com' && /^\/r\/styles\/[^/]+\//.test(origin.pathname)
        await visit(
          null,
          null,
          official ? new URL(`${dependency}.json`, origin).href : templateUrls(OFFICIAL.template, dependency)[0]!,
        )
      } else {
        throw new Error(`Cannot resolve registry dependency “${dependency}”`)
      }
    }
    return item
  }
  const rootItems: RegistryItem[] = []
  for (const selection of selections) {
    const registry = await registryAt(selection.source)
    const item = registry.items.find((candidate) => candidate.name === selection.name)
    if (!item) throw new RegistryInputError(`Registry item “${selection.name}” is no longer available`)
    const root = await visit(registry, item, registry.index ? registry.itemUrl(item.name) : registry.url)
    if (root) rootItems.push(root)
  }
  /* community items (demos especially) import shadcn's own primitives,
     `@/components/ui/card`, without listing them: their users already have
     them. Whatever is imported and not provided comes from the official
     registry, as `npx shadcn add card` would bring it. */
  const provided = (name: string) =>
    [...resolved.values()].some(({ item }) =>
      item.files?.some((file) => new RegExp(`(^|/)ui/${name}\\.[jt]sx?$`).test(file.target ?? file.path)),
    )
  for (let round = 0; round < 3; round++) {
    const wanted = new Set<string>()
    for (const { item } of resolved.values())
      for (const file of item.files ?? [])
        for (const match of (file.content ?? '').matchAll(/["'](?:@|~)\/components\/ui\/([a-z0-9-]+)["']/g))
          if (!provided(match[1]!)) wanted.add(match[1]!)
    if (!wanted.size) break
    for (const name of wanted) await visit(null, null, templateUrls(OFFICIAL.template, name)[0]!)
  }
  return { selected: rootItems, items: [...resolved.values()].map(({ item }) => item) }
}
