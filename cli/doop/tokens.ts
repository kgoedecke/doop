import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { callJson, callTool } from './client.ts'
import { need, type Context, type Outcome } from './context.ts'
import { CliError, EXIT, usage } from './errors.ts'

/**
 * Design tokens between the canvas and a file in the repository. `pull` writes them as JSON, a
 * `:root` CSS block, a Tailwind v4 `@theme` block or markdown; `push` reads the JSON form and
 * sends only what differs, so the same file can be pushed on every merge.
 */

interface Token {
  name: string
  /** required for a new token; an existing one keeps its type without it */
  type?: string
  value: string | number
  themes?: Record<string, string | number>
  description?: string
}

type TokenResult = { name: string; result: 'created' | 'updated' | 'deleted' | 'error'; message?: string }

const FORMATS = ['json', 'css', 'tailwind', 'markdown']
/** create_tokens and set_tokens take this many entries a call */
const BATCH = 200

async function pullTokens(context: Context): Promise<Outcome> {
  const format = context.flags.format ?? 'json'
  if (!FORMATS.includes(format)) throw usage(`--format is one of ${FORMATS.join(', ')}`)
  const result = await callTool(context.connection, 'get_tokens', { canvas_id: context.canvasId(), format })
  context.feedback.push(...result.feedback)
  if (!context.flags.out) return { text: result.text, data: format === 'json' ? JSON.parse(result.text) : result.text }
  const path = resolve(context.cwd, context.flags.out)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, result.text.endsWith('\n') ? result.text : `${result.text}\n`)
  return { text: `wrote ${context.flags.out}`, data: { file: path, format } }
}

function readTokenFile(path: string): Token[] {
  if (!existsSync(path)) throw new CliError(`${path} does not exist`, EXIT.notFound)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw usage(`${path} is not JSON`, '`doop tokens pull -o tokens.json` writes the shape `push` reads')
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { tokens?: unknown }).tokens
  if (!Array.isArray(list))
    throw usage(
      `${path} holds no token list`,
      'expected { "tokens": [{ "name": "--color-primary", "type": "color", "value": "#0177d3" }] }',
    )
  return list as Token[]
}

/** Does the canvas's token already say what the file's does? Values are compared as the
 *  canvas stores them, as text, and only for what the file states: an entry without a `type`
 *  or a `description` leaves the canvas's as it is, so it is not a difference on every push. */
function same(file: Token, canvas: Token): boolean {
  const themes = (token: Token) =>
    JSON.stringify(
      Object.entries(token.themes ?? {})
        .map(([theme, value]) => [theme, String(value)])
        .sort(),
    )
  return (
    String(file.value) === String(canvas.value) &&
    (file.type === undefined || file.type === canvas.type) &&
    (file.description === undefined || file.description === (canvas.description ?? '')) &&
    themes(file) === themes(canvas)
  )
}

async function pushTokens(context: Context): Promise<Outcome> {
  const file = need(context.args[1], 'a token file', 'usage: doop tokens push <tokens.json> [--prune]')
  const canvasId = context.canvasId()
  const wanted = readTokenFile(resolve(context.cwd, file))
  const { value } = await callJson<{ tokens: Token[] }>(context.connection, 'get_tokens', { canvas_id: canvasId })
  const current = new Map(value.tokens.map((token) => [token.name, token]))
  const names = new Set(wanted.map((token) => token.name))

  const created = wanted.filter((token) => !current.has(token.name))
  const changed = wanted
    .filter((token) => current.has(token.name) && !same(token, current.get(token.name)!))
    .map((token) => {
      /* a theme the file dropped is removed, not left behind */
      const dropped = Object.keys(current.get(token.name)?.themes ?? {}).filter(
        (theme) => !(theme in (token.themes ?? {})),
      )
      return { ...token, themes: { ...token.themes, ...Object.fromEntries(dropped.map((theme) => [theme, null])) } }
    })
  const removed = context.flags.prune
    ? value.tokens.filter((token) => !names.has(token.name)).map((token) => ({ name: token.name, delete: true }))
    : []

  const results: TokenResult[] = []
  const send = async (tool: string, entries: unknown[]) => {
    for (let at = 0; at < entries.length; at += BATCH) {
      const written = await callJson<{ results: TokenResult[] }>(context.connection, tool, {
        canvas_id: canvasId,
        tokens: entries.slice(at, at + BATCH),
      })
      context.heard(written.result)
      results.push(...written.value.results)
    }
  }
  await send('create_tokens', created)
  await send('set_tokens', [...changed, ...removed])

  const failed = results.filter((entry) => entry.result === 'error')
  const count = (kind: string) => results.filter((entry) => entry.result === kind).length
  const unchanged = wanted.length - created.length - changed.length
  return {
    text: [
      `${count('created')} created, ${count('updated')} updated, ${count('deleted')} deleted, ${unchanged} unchanged`,
      ...failed.map((entry) => `error ${entry.name}: ${entry.message}`),
    ].join('\n'),
    data: { results, unchanged },
    ...(failed.length ? { exitCode: EXIT.error } : {}),
  }
}

export function tokens(context: Context): Promise<Outcome> {
  const [action] = context.args
  if (action === 'pull') return pullTokens(context)
  if (action === 'push') return pushTokens(context)
  throw usage(
    'usage: doop tokens pull [--format json|css|tailwind|markdown] [-o file]\n       doop tokens push <tokens.json> [--prune]',
  )
}
