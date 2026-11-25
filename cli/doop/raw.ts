import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { callTool, listTools } from './client.ts'
import { need, type Context, type Outcome } from './context.ts'
import { CliError, EXIT, usage } from './errors.ts'
import { AGENTS_BLOCK, AGENTS_BLOCK_END, AGENTS_BLOCK_START, PRIMER, SKILL } from './primer.ts'

/**
 * The whole MCP tool set from the shell: `doop call` runs any tool, `doop tools` describes them,
 * `doop guide` prints the agent guide. The commands with their own shape (pull, push, screenshot,
 * wait) cover the design loop; this covers everything else without a command per tool.
 */

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
}

/** One argument. `key=value` is text, whatever it looks like (`text=42` is the string "42",
 *  `text=@Ana done` starts with a mention); `key:=value` is JSON, for numbers, booleans and
 *  lists; `key@=path` takes a file's contents, which is how markup gets in without quoting. */
function parsePair(context: Context, pair: string): [string, unknown] {
  const at = pair.indexOf('=')
  if (at < 1)
    throw usage(
      `"${pair}" is not key=value`,
      'pass arguments as key=text, key:=json, key@=file, or one JSON object: doop call search_icons query=arrow',
    )
  const kind = pair[at - 1] === ':' ? 'json' : pair[at - 1] === '@' ? 'file' : 'text'
  const key = pair.slice(0, kind === 'text' ? at : at - 1)
  const raw = pair.slice(at + 1)
  if (kind === 'json') {
    try {
      return [key, JSON.parse(raw)]
    } catch {
      throw usage(`${key}:= takes JSON, got "${raw}"`, `for text, write ${key}=${raw}`)
    }
  }
  if (kind === 'file') {
    const path = resolve(context.cwd, raw)
    if (!existsSync(path)) throw new CliError(`${path} does not exist`, EXIT.notFound)
    return [key, readFileSync(path, 'utf8')]
  }
  return [key, raw]
}

function parseObject(text: string, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    /* reported below */
  }
  throw usage(`${source} is not a JSON object`)
}

function toolArguments(context: Context, parts: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const part of parts) {
    if (part === '-') Object.assign(args, parseObject(readFileSync(0, 'utf8'), 'stdin'))
    else if (part.trimStart().startsWith('{')) Object.assign(args, parseObject(part, 'the argument'))
    else {
      const [key, value] = parsePair(context, part)
      args[key] = value
    }
  }
  /* a tool that takes no canvas ignores it */
  const canvas = context.flags.canvas ?? context.project?.config.canvas
  return canvas && args.canvas_id === undefined ? { canvas_id: canvas, ...args } : args
}

export async function call(context: Context): Promise<Outcome> {
  const [tool, ...parts] = context.args
  const name = need(
    tool,
    'a tool name',
    'usage: doop call <tool> [key=text…] [key:=json…] [key@=file…] ; `doop tools` lists them',
  )
  const result = await callTool(context.connection, name, toolArguments(context, parts))
  context.heard(result)
  const files = result.files.map((file, index) => {
    const ext = EXTENSIONS[file.mime] ?? 'bin'
    const path = resolve(
      context.cwd,
      context.flags.out && result.files.length === 1
        ? context.flags.out
        : join(context.flags.out ?? '.', `${name}${index ? `-${index + 1}` : ''}.${ext}`),
    )
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.data)
    return path
  })
  let parsed: unknown = result.text
  try {
    parsed = JSON.parse(result.text)
  } catch {
    /* prose (a guide, a CSS block) stays text */
  }
  return {
    text: [result.text, ...files.map((file) => `saved ${file}`)].filter(Boolean).join('\n'),
    data: { result: parsed, files },
  }
}

export async function tools(context: Context): Promise<Outcome> {
  const all = await listTools(context.connection)
  const wanted = context.args[0]
  if (!wanted)
    return {
      text: all.map((tool) => `${tool.name}\t${tool.title ?? ''}`.trimEnd()).join('\n'),
      data: { tools: all.map((tool) => ({ name: tool.name, title: tool.title })) },
    }
  const tool = all.find((entry) => entry.name === wanted)
  if (!tool) throw new CliError(`no tool named ${wanted}`, EXIT.notFound, '`doop tools` lists them')
  return {
    text: [
      `${tool.name}: ${tool.title ?? ''}`.trimEnd(),
      '',
      tool.description ?? '',
      '',
      'arguments, as key=text, key:=json or key@=file (canvas_id and agent_name are filled in for you):',
      JSON.stringify((tool.inputSchema as { properties?: unknown } | undefined)?.properties ?? {}, null, 2),
    ].join('\n'),
    data: tool,
  }
}

export async function guide(context: Context): Promise<Outcome> {
  const topic = context.args[0]
  const result = await callTool(context.connection, 'get_guide', { topic: topic ?? 'doop-instructions' })
  /* the main guide is read with the CLI's own primer ahead of it */
  const text = topic ? result.text : `${PRIMER}\n---\n\n${result.text}`
  return { text, data: { topic: topic ?? 'doop-instructions', guide: text } }
}

/** Puts the block between its markers, replacing an earlier one. */
function withAgentsBlock(existing: string): string {
  const start = existing.indexOf(AGENTS_BLOCK_START)
  const end = existing.indexOf(AGENTS_BLOCK_END)
  if (start >= 0 && end > start)
    return existing.slice(0, start) + AGENTS_BLOCK + existing.slice(end + AGENTS_BLOCK_END.length)
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${AGENTS_BLOCK}\n`
}

/** Tells the coding agents that work in this repository that Doop is here: a block in
 *  AGENTS.md, and a Claude Code skill where the repository is set up for Claude (or with --skill). */
export function init(context: Context): Promise<Outcome> {
  const root = context.project?.root ?? context.cwd
  const written: string[] = []
  const agentsPath = join(root, 'AGENTS.md')
  const before = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : ''
  const after = withAgentsBlock(before)
  if (after !== before) {
    writeFileSync(agentsPath, after)
    written.push('AGENTS.md')
  }
  if (context.flags.skill || existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md'))) {
    const skillPath = join(root, '.claude', 'skills', 'doop', 'SKILL.md')
    if (!existsSync(skillPath) || readFileSync(skillPath, 'utf8') !== SKILL) {
      mkdirSync(dirname(skillPath), { recursive: true })
      writeFileSync(skillPath, SKILL)
      written.push('.claude/skills/doop/SKILL.md')
    }
  }
  return Promise.resolve({
    text: [
      written.length ? `wrote ${written.join(' and ')}` : 'already set up: nothing to write',
      ...(context.project ? [] : ['this directory is not linked yet: run `doop link <canvas id, name or URL>`']),
    ].join('\n'),
    data: { written },
  })
}
