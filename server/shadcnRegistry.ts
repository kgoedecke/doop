import { z } from 'zod'
import { fetchPinnedPublicUrl, parsePublicHttpUrl } from './publicUrl.ts'
import type { RegistryPreview } from '../shared/shadcnRegistry.ts'

const MAX_JSON_BYTES = 2_000_000
const MAX_SOURCE_CHARS = 160_000
const MAX_RESOLVED_ITEMS = 40
export const MAX_REGISTRY_SELECTION = 20

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
  name: z.string().min(1).max(200),
  items: z.array(itemSchema).min(1).max(500),
})
export type RegistryItem = z.infer<typeof itemSchema>

function registryUrl(raw: string): URL {
  if (raw.length > 2000) throw new Error('Registry URL is too long')
  return parsePublicHttpUrl(raw)
}

async function fetchJson(raw: string, signal: AbortSignal): Promise<{ url: string; value: unknown }> {
  let url = registryUrl(raw)
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetchPinnedPublicUrl(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('Registry redirect has no destination')
      url = registryUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Could not fetch registry (${response.status})`)
    }
    if (Number(response.headers.get('content-length')) > MAX_JSON_BYTES) {
      await response.body?.cancel()
      throw new Error('Registry JSON is too large')
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
        if (size > MAX_JSON_BYTES) throw new Error('Registry JSON is too large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    try {
      return { url: url.href, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    } catch {
      throw new Error('The URL did not return valid registry JSON')
    }
  }
  throw new Error('Too many registry redirects')
}

async function readRegistry(raw: string, signal: AbortSignal) {
  const fetched = await fetchJson(raw, signal)
  const index = indexSchema.safeParse(fetched.value)
  if (index.success) {
    const items = index.data.items
    if (new Set(items.map((item) => item.name)).size !== items.length)
      throw new Error('Registry has duplicate item names')
    return { url: fetched.url, name: index.data.name, items, index: true }
  }
  const item = itemSchema.safeParse(fetched.value)
  if (!item.success) throw new Error('Expected a shadcn registry.json or registry item JSON URL')
  return { url: fetched.url, name: item.data.title ?? item.data.name, items: [item.data], index: false }
}

export async function previewRegistry(raw: string): Promise<RegistryPreview> {
  const registry = await readRegistry(raw, AbortSignal.timeout(45_000))
  return {
    url: registry.url,
    name: registry.name,
    items: registry.items.map((item) => ({
      name: item.name,
      title: item.title ?? item.name,
      description: item.description ?? '',
      type: item.type,
    })),
  }
}

/** Resolve the selected items and their source dependencies without installing packages. */
export async function prepareRegistryImport(raw: string, names: string[]) {
  if (!names.length || names.length > MAX_REGISTRY_SELECTION || new Set(names).size !== names.length) {
    throw new Error(`Select between 1 and ${MAX_REGISTRY_SELECTION} distinct registry items`)
  }
  const signal = AbortSignal.timeout(45_000)
  const registry = await readRegistry(raw, signal)
  const selected = names.map((name) => {
    const item = registry.items.find((candidate) => candidate.name === name)
    if (!item) throw new Error(`Registry item “${name}” is no longer available; review the registry again`)
    return item
  })
  const resolved = new Map<string, { url: string; item: RegistryItem }>()
  const visited = new Set<string>()
  let total = 0

  async function visit(item: RegistryItem | null, url: string): Promise<RegistryItem | undefined> {
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
      if (item.files?.some((file) => file.content === undefined)) {
        throw new Error(`“${item.name}” does not include file contents; use its published registry item JSON URL`)
      }
    }
    const source = JSON.stringify(item, null, 2)
    total += source.length
    if (total > MAX_SOURCE_CHARS) throw new Error('Registry source is too large; import fewer items')
    resolved.set(key, { url, item })
    for (const dependency of item.registryDependencies ?? []) {
      const local = registry.items.find((candidate) => candidate.name === dependency)
      if (local) {
        await visit(local, registry.index ? new URL(`${local.name}.json`, registry.url).href : registry.url)
      } else if (/^https?:\/\//i.test(dependency)) {
        await visit(null, parsePublicHttpUrl(dependency).href)
      } else if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(dependency)) {
        await visit(null, `https://ui.shadcn.com/r/styles/new-york-v4/${dependency}.json`)
      } else {
        throw new Error(
          `Cannot resolve registry dependency “${dependency}”; use a registry with public dependency URLs`,
        )
      }
    }
    return item
  }
  const rootItems: RegistryItem[] = []
  for (const item of selected) {
    const root = await visit(item, registry.index ? new URL(`${item.name}.json`, registry.url).href : registry.url)
    if (root) rootItems.push(root)
  }
  return { selected: rootItems, items: [...resolved.values()].map(({ item }) => item), url: registry.url }
}
