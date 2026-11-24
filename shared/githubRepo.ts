/**
 * What someone pastes to name a GitHub repository: its link as the browser
 * shows it (`https://github.com/owner/repo`, a `/tree/<branch>` or file link,
 * with or without `www.` or the scheme), a clone URL (`.git`, `git@github.com:`)
 * or plain `owner/repo`. Another host, or one of GitHub's own pages
 * (`/orgs/…`, `/settings/…`), is not a repository.
 *
 * A `/tree/…` or `/blob/…` link cannot say where its branch name ends
 * (`feature/login` is one branch), so it is read as `treePath`, every segment
 * after `tree` or `blob`, and the server finds the longest prefix that is a
 * branch. A `.` or `..` segment is refused: it would change the API path.
 */
export type RepoRef = { repo: string; treePath?: string[] }

/* GitHub account names: letters, digits and single hyphens */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const NAME = /^[\w.-]+$/
/* first path segments that are GitHub's own pages, not accounts */
const RESERVED = new Set([
  'orgs',
  'settings',
  'users',
  'marketplace',
  'apps',
  'sponsors',
  'topics',
  'features',
  'explore',
  'notifications',
  'login',
  'new',
  'organizations',
  'enterprises',
])

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function parseRepoRef(input: string): RepoRef | null {
  const text = input
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
  const [owner, rawName, kind, ...rest] = text.split('/').filter(Boolean)
  const name = rawName?.replace(/\.git$/i, '')
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || RESERVED.has(owner.toLowerCase())) return null
  const repo = `${owner}/${name}`
  if ((kind !== 'tree' && kind !== 'blob') || !rest.length) return { repo }
  const treePath = rest.map(decoded)
  return treePath.every((s): s is string => s !== null && s !== '.' && s !== '..') ? { repo, treePath } : null
}

/** The branch names a `/tree/…` link may mean, longest first. */
export function branchCandidates(treePath: string[], max = 6): string[] {
  const out: string[] = []
  for (let n = Math.min(treePath.length, max); n >= 1; n--) out.push(treePath.slice(0, n).join('/'))
  return out
}
