/* When to ask for a GitHub star (StarCard): only once someone has come back
   to Doop on a few different days, never on a first visit, and never again
   once they starred or said no. Kept per browser, like the native-app promo. */

export const GITHUB_REPO_URL = 'https://github.com/kgoedecke/doop'

const STORAGE_KEY = 'doop:github-star'
/** Distinct days of use before the card is offered. */
export const STAR_MIN_ACTIVE_DAYS = 3
/** How long "Later" keeps the card away. */
export const STAR_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000
/* only the newest days matter, so the list cannot grow without bound */
const KEPT_DAYS = STAR_MIN_ACTIVE_DAYS

type StarState = { days?: string[]; snoozedAt?: number; done?: 'starred' | 'dismissed' }

function read(): StarState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as StarState) : {}
  } catch {
    return {}
  }
}

function write(state: StarState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage refused (private mode): the card simply never qualifies */
  }
}

function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** Counts today as a day Doop was used. */
export function noteActiveDay(now = Date.now()) {
  const state = read()
  if (state.done) return
  const today = dayOf(now)
  const days = state.days ?? []
  if (days.includes(today)) return
  write({ ...state, days: [...days, today].slice(-KEPT_DAYS) })
}

export function starPromptDue(now = Date.now()): boolean {
  const { days = [], snoozedAt, done } = read()
  if (done) return false
  if (snoozedAt !== undefined && now - snoozedAt < STAR_SNOOZE_MS) return false
  return days.length >= STAR_MIN_ACTIVE_DAYS
}

export function snoozeStarPrompt(now = Date.now()) {
  write({ ...read(), snoozedAt: now })
}

export function finishStarPrompt(how: 'starred' | 'dismissed') {
  write({ done: how })
}
