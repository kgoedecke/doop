/**
 * doop: Doop from a shell, for coding agents and scripts.
 *
 * Shaped for a process that has a filesystem: frames and components are pulled to local files
 * and pushed back, screenshots and exports land on disk and only their path is printed, and
 * `doop wait` blocks until a person on the canvas asks for something. Frame HTML travels as
 * files over the agent API (`/api/v1`, cli/doop/api.ts); everything else calls the MCP tools
 * over plain HTTP (`/mcp`, cli/doop/client.ts), and any tool is reachable as `doop call <tool>`.
 * Both take an agent key.
 *
 *   doop login --key dpk_…        (or DOOP_API_KEY)
 *   doop link <canvas>            writes .doop/config.json
 *   doop pull                     frames -> designs/*.html
 *   doop push                     changed files -> the canvas
 *   doop screenshot designs/hero.html
 *
 * Built to public/cli/doop.mjs by scripts/build-doop-cli.mjs and served by Doop, so a server
 * always hands out the CLI that matches its tools. Behaviour: .context/reference/agents.md.
 */
import { parseCommandLine } from './doop/args.ts'
import { asset } from './doop/assets.ts'
import { createContext, type Context, type Flags, type Outcome } from './doop/context.ts'
import { CliError, EXIT, usage } from './doop/errors.ts'
import { diff, frames } from './doop/frames.ts'
import { expand, exportFrames, inspect, screenshot } from './doop/look.ts'
import { call, guide, init, tools } from './doop/raw.ts'
import { canvases, link, login, logout, status, whoami } from './doop/session.ts'
import { pull, push } from './doop/sync.ts'
import { tokens } from './doop/tokens.ts'
import { wait } from './doop/wait.ts'

/* set by the build; absent when the source is run directly */
declare const DOOP_CLI_VERSION: string | undefined

interface Command {
  run(context: Context): Promise<Outcome>
  summary: string
  usage: string[]
}

const COMMANDS: Record<string, Command> = {
  login: {
    run: login,
    summary: 'sign in: approve in the browser, or pass an agent key (or set DOOP_API_KEY and skip this)',
    usage: [
      'doop login                    opens your browser to approve this machine',
      'doop login --no-browser       prints a link and takes the code it shows, for a machine with no browser',
      'doop login --key <dpk_…>      an agent key from Settings → Agent keys, for CI',
      '  --server <origin> signs in to a self-hosted server',
    ],
  },
  logout: { run: logout, summary: 'forget the saved key', usage: ['doop logout [--server <origin>]'] },
  whoami: { run: whoami, summary: 'the account, server and canvas in use', usage: ['doop whoami'] },
  canvases: { run: canvases, summary: 'canvases this key can open', usage: ['doop canvases'] },
  link: {
    run: link,
    summary: 'link this directory to a canvas',
    usage: ['doop link <canvas id, name or URL> [--dir designs]', 'doop link --create "<name>"'],
  },
  init: {
    run: init,
    summary: 'tell coding agents in this repository about Doop (AGENTS.md, Claude skill)',
    usage: ['doop init [--skill]'],
  },
  guide: {
    run: guide,
    summary: 'how to design in Doop: read this first',
    usage: ['doop guide [components|images|prototypes|redesigns|comments-and-agents|export|imported-frames]'],
  },
  frames: { run: frames, summary: 'the frames on the canvas', usage: ['doop frames [--ready]'] },
  pull: {
    run: pull,
    summary: 'frames and components -> local files',
    usage: [
      'doop pull                     components and tracked frames (every frame the first time)',
      'doop pull <frame or file>… [--force]  by name, id or file; --force overwrites local changes',
      'doop pull --all | --ready     every frame | the ones a person marked ready for dev',
      'doop pull … --expand          also write each frame as it renders (see `doop expand`)',
    ],
  },
  push: {
    run: push,
    summary: 'local files -> the canvas',
    usage: [
      'doop push                     every tracked file that changed, components first',
      'doop push <file>… [--force]   --force overwrites what changed on the canvas',
      'doop push <new frame.html> [--name "Hero"] [--width 1440] [--height 900] [--page <page>]',
      'doop push <dir>/components/<new>.html   a new component, with .css and .json beside it',
    ],
  },
  diff: { run: diff, summary: 'local files against the canvas', usage: ['doop diff [file…]'] },
  screenshot: {
    run: screenshot,
    summary: 'render a frame to a PNG and print its path',
    usage: ['doop screenshot <frame, frame file or component file> [-o file.png] [--scale 2]'],
  },
  expand: {
    run: expand,
    summary: 'a frame as it renders, components written out, to a file a browser opens',
    usage: ['doop expand <frame or file>… [-o file.html]'],
  },
  inspect: {
    run: inspect,
    summary: 'layout problems in a rendered frame, as data',
    usage: ['doop inspect <frame or file> [--selector <css>]… [--fail-on-problems]'],
  },
  export: {
    run: exportFrames,
    summary: 'frames as PNG, JPG or one PDF, written to disk',
    usage: ['doop export <frame or file>… | --all  [--format png|jpg|pdf] [--scale 2] [--quality 90] [-o dir or file]'],
  },
  wait: {
    run: wait,
    summary: 'block until a person leaves feedback or a comment',
    usage: ['doop wait [--feedback] [--comments] [--frame <frame>] [--timeout 30m] [--interval 5s]'],
  },
  status: { run: status, summary: 'show people what you are working on', usage: ['doop status "<one line>"'] },
  tokens: {
    run: tokens,
    summary: 'design tokens to and from a file',
    usage: [
      'doop tokens pull [--format json|css|tailwind|markdown] [-o file]',
      'doop tokens push <tokens.json> [--prune]',
    ],
  },
  asset: { run: asset, summary: 'upload images, get URLs', usage: ['doop asset upload <file or URL>…'] },
  tools: { run: tools, summary: 'every MCP tool, or one in full', usage: ['doop tools [name]'] },
  call: {
    run: call,
    summary: 'run any MCP tool',
    usage: [
      'doop call <tool> [key=text…] [key:=json…] [key@=file…] [\'{"json":"object"}\'] [-] [-o file]',
      '  key=text is always a string; key:=1440, key:=true or key:=["a","b"] is JSON; key@=hero.html is that file',
    ],
  },
}

function overview(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  return [
    'doop: design on a Doop canvas from the shell',
    '',
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`),
    '',
    'Everywhere: --json (one JSON document on stdout), --canvas <id>, --server <origin>, --agent <name>',
    'Environment: DOOP_API_KEY, DOOP_SERVER, DOOP_AGENT_NAME',
    `Exit codes: 0 ok, ${EXIT.error} failed, ${EXIT.usage} usage, ${EXIT.conflict} conflict with the canvas, ${EXIT.auth} not signed in, ${EXIT.notFound} not found, ${EXIT.timeout} wait timed out`,
    '',
    '`doop <command> --help` shows its usage. New here? `doop guide`.',
  ].join('\n')
}

function parse(argv: string[]): { flags: Flags; positionals: string[] } {
  try {
    return parseCommandLine(argv)
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error), '`doop help` lists the commands and options')
  }
}

function print(outcome: Outcome, context: Context): void {
  const notes = [...new Set([...(outcome.notes ?? []), ...context.notes])]
  const feedback = [...new Set([...(outcome.feedback ?? []), ...context.feedback])]
  if (context.flags.json) {
    console.log(
      JSON.stringify({
        ok: !outcome.exitCode,
        data: outcome.data ?? null,
        ...(context.warnings.length ? { warnings: context.warnings } : {}),
        ...(notes.length ? { notes } : {}),
        ...(feedback.length ? { feedback } : {}),
      }),
    )
    return
  }
  /* what did not land as written comes first: it is the line an agent must not miss */
  for (const warning of context.warnings) console.log(`warning: ${warning}`)
  console.log(outcome.text)
  for (const item of feedback) console.log(`\n${item}`)
  for (const note of notes) console.log(`\nnote: ${note}`)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  let context: Context | undefined
  try {
    const { flags, positionals } = parse(argv)
    const [name, ...args] = positionals
    if (flags.version) {
      console.log(typeof DOOP_CLI_VERSION === 'undefined' ? 'dev' : DOOP_CLI_VERSION)
      return 0
    }
    if (!name || name === 'help') {
      const topic = COMMANDS[args[0] ?? '']
      console.log(topic ? topic.usage.join('\n') : overview())
      return 0
    }
    const command = COMMANDS[name]
    if (!command) throw usage(`unknown command "${name}"`, '`doop help` lists the commands')
    if (flags.help) {
      console.log(`${command.summary}\n\n${command.usage.join('\n')}`)
      return 0
    }
    context = createContext(flags, args, process.env, process.cwd())
    const outcome = await command.run(context)
    print(outcome, context)
    return outcome.exitCode ?? 0
  } catch (error) {
    const failure =
      error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error))
    /* an earlier step of the command may have landed, and with it the server handed over
       warnings and feedback it now counts as delivered: they are printed with the failure */
    const heard = {
      ...(context?.warnings.length ? { warnings: context.warnings } : {}),
      ...(context?.notes.length ? { notes: context.notes } : {}),
      ...(context?.feedback.length ? { feedback: context.feedback } : {}),
    }
    if (json)
      console.log(
        JSON.stringify({
          ok: false,
          error: failure.message,
          ...(failure.hint ? { hint: failure.hint } : {}),
          ...heard,
        }),
      )
    else {
      for (const warning of heard.warnings ?? []) console.log(`warning: ${warning}`)
      for (const item of heard.feedback ?? []) console.log(`${item}\n`)
      console.error(`doop: ${failure.message}${failure.hint ? `\n  ${failure.hint}` : ''}`)
    }
    return failure.exitCode
  }
}

/* exitCode rather than exit(): stdout may still hold a long guide or a diff */
process.exitCode = await main()
