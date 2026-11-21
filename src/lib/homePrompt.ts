/**
 * The home composer's pure parts: it starts a fresh canvas from a prompt and
 * queues that prompt as the first board card, optionally asking for several
 * drafts of the same brief so there is something to iterate between.
 */

/** the counts the composer offers as one-click picks; the default is the middle of the road */
export const DRAFT_OPTIONS = [1, 2, 3, 4] as const
/** a whole number of drafts, at least one */
export type DraftCount = number
export const DEFAULT_DRAFTS: DraftCount = 3
export const DRAFTS_STORAGE_KEY = 'doop-home-drafts'

const MAX_CANVAS_NAME = 48

export function isDraftCount(value: unknown): value is DraftCount {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** A count typed into the menu's field: a whole number of at least one; null when nothing usable was typed. */
export function parseDraftCount(text: string): DraftCount | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return isDraftCount(n) ? n : null
}

/** The canvas takes its name from the prompt's first line, cut at a word
 *  boundary so a long brief does not become a long tab title. */
export function canvasNameFromPrompt(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim()
  if (!line) return 'Untitled canvas'
  if (line.length <= MAX_CANVAS_NAME) return line
  const cut = line.slice(0, MAX_CANVAS_NAME)
  const space = cut.lastIndexOf(' ')
  return `${(space > MAX_CANVAS_NAME / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The card the agent picks up. One draft is the prompt as written; more
 *  than one asks for that many distinct takes, each in its own frame. */
export function draftsCardTitle(text: string, drafts: DraftCount): string {
  const prompt = text.trim()
  if (drafts <= 1) return prompt
  return `Make ${drafts} distinct drafts of this, each as its own frame side by side, so they can be compared:\n\n${prompt}`
}

export function readStoredDrafts(storage: Pick<Storage, 'getItem'> | undefined): DraftCount {
  try {
    const raw = storage?.getItem(DRAFTS_STORAGE_KEY)
    const n = raw === null || raw === undefined ? NaN : Number(raw)
    return isDraftCount(n) ? n : DEFAULT_DRAFTS
  } catch {
    return DEFAULT_DRAFTS
  }
}
