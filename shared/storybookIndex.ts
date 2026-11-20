/**
 * Reading a Storybook's story index (`index.json`, or v6's `stories.json`) into the components an
 * import offers: one per story title, with the story it is lifted from.
 * Spec: .context/specs/storybook-import.md.
 */

export interface StoryEntry {
  id: string
  title: string
  name: string
  importPath?: string
  componentPath?: string
}

export interface StorybookComponent {
  /** the story title, `Components/Button`: what identifies it across syncs */
  title: string
  /** the Doop component's name, `Button` */
  name: string
  /** the story it is lifted from */
  baseStoryId: string
  stories: { id: string; name: string }[]
  /** where it lives in code */
  codePath?: string
}

/** The Storybook a URL points at: its origin and path, without the manager's query or a page. */
export function storybookBase(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs')
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed')
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/(index|iframe)\.html$/, '/').replace(/\/?$/, '/')
  return url
}

/** The URL that renders one story on its own. */
export function storyUrl(base: URL, storyId: string): string {
  const url = new URL('iframe.html', base)
  url.searchParams.set('id', storyId)
  url.searchParams.set('viewMode', 'story')
  return url.href
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** The stories (not docs pages) of an index, whatever its version. */
export function parseStoryIndex(json: unknown): StoryEntry[] {
  if (!isRecord(json)) throw new Error('not a Storybook index')
  const table = isRecord(json.entries) ? json.entries : isRecord(json.stories) ? json.stories : null
  if (!table) throw new Error('not a Storybook index')
  const stories: StoryEntry[] = []
  for (const raw of Object.values(table)) {
    if (!isRecord(raw)) continue
    const id = str(raw.id)
    const title = str(raw.title) ?? str(raw.kind)
    const name = str(raw.name) ?? str(raw.story)
    if (!id || !title || !name) continue
    /* v7+ marks docs pages; v6 lists a docs-only page as a story with parameters.docsOnly */
    if (raw.type === 'docs') continue
    if (isRecord(raw.parameters) && raw.parameters.docsOnly) continue
    stories.push({ id, title, name, importPath: str(raw.importPath), componentPath: str(raw.componentPath) })
  }
  return stories
}

const BASE_STORY = /^(default|primary|basic|playground|base|overview|example)$/i

const pathOf = (path: string | undefined) => path?.replace(/^\.\//, '')

/** Doop names for titles: the last segment, more of the path where two would clash. */
function componentNames(titles: string[]): Map<string, string> {
  const segments = new Map(titles.map((title) => [title, title.split('/').map((part) => part.trim())]))
  const names = new Map<string, string>()
  for (let depth = 1; names.size < titles.length; depth++) {
    const pending = titles.filter((title) => !names.has(title))
    const tried = new Map(pending.map((title) => [title, segments.get(title)!.slice(-depth).join(' ')]))
    const counts = new Map<string, number>()
    for (const name of tried.values()) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1)
    for (const [title, name] of tried) {
      const whole = depth >= segments.get(title)!.length
      if (counts.get(name.toLowerCase()) === 1 || whole) names.set(title, name.slice(0, 60) || 'Component')
    }
  }
  return names
}

/** A component per title, in index order. */
export function groupComponents(stories: StoryEntry[]): StorybookComponent[] {
  const byTitle = new Map<string, StoryEntry[]>()
  for (const story of stories) byTitle.set(story.title, [...(byTitle.get(story.title) ?? []), story])
  const names = componentNames([...byTitle.keys()])
  return [...byTitle].map(([title, group]) => {
    const base = group.find((story) => BASE_STORY.test(story.name)) ?? group[0]!
    const codePath = pathOf(group.find((story) => story.componentPath)?.componentPath ?? base.importPath)
    return {
      title,
      name: names.get(title)!,
      baseStoryId: base.id,
      stories: group.map((story) => ({ id: story.id, name: story.name })),
      ...(codePath ? { codePath } : {}),
    }
  })
}
