/**
 * doop-storybook: a Storybook only this machine reaches (localhost, behind a VPN) into Doop
 * components. It renders the stories here, with the Playwright or Puppeteer the project already
 * has, captures them the way Doop's server does, and sends the captures to Doop's
 * `import_storybook` over MCP with an agent key. Spec: .context/specs/storybook-import.md.
 *
 *   node doop-storybook.mjs list <storybook url>
 *   DOOP_KEY=… node doop-storybook.mjs push <storybook url> --canvas <id> [--server <origin>]
 *       [--only "Components/Button,Components/Card"] [--match <regex>]
 *
 * Built to public/cli/doop-storybook.mjs by scripts/build-storybook-cli.mjs; served by Doop.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { acquireComponent, type ComponentCapture, type StoryTab } from '../shared/storybookAcquire.ts'
import { CAPTURE_ROOT_ATTR, storybookPage, type StoryCommand } from '../shared/storybookCapture.ts'
import { groupComponents, parseStoryIndex, storybookBase, type StorybookComponent } from '../shared/storybookIndex.ts'

const MAX_COMPONENTS = 60
/* /mcp takes 10 MB a request: leave room for the envelope */
const MAX_BATCH_BYTES = 8_000_000
const VIEWPORT = { width: 1280, height: 900 }

function fail(message: string): never {
  console.error(`doop-storybook: ${message}`)
  process.exit(1)
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/* ------------------------------------------------------------------ */
/* A browser from the project                                          */

interface Browser {
  tab(): Promise<StoryTab & { close(): Promise<void> }>
  close(): Promise<void>
}

/* the shapes of the two libraries this uses, so neither needs to be installed to build */
interface AnyPage {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>
  $(selector: string): Promise<{
    screenshot(options: Record<string, unknown>): Promise<Uint8Array>
    boundingBox(): Promise<{ width: number; height: number } | null>
  } | null>
  close(): Promise<void>
}

interface PuppeteerLike {
  launch(): Promise<{
    newPage(): Promise<
      AnyPage & {
        setViewport(v: unknown): Promise<void>
        evaluateOnNewDocument(s: string): Promise<unknown>
        emulateMediaFeatures(f: unknown[]): Promise<void>
      }
    >
    close(): Promise<void>
  }>
}

async function openBrowser(): Promise<Browser> {
  const require = createRequire(join(process.cwd(), 'package.json'))
  const shim = 'globalThis.__name = (target) => target'
  try {
    const { chromium } = require('playwright') as {
      chromium: {
        launch(): Promise<{
          newPage(o: Record<string, unknown>): Promise<
            AnyPage & {
              addInitScript(s: string): Promise<void>
              emulateMedia(o: Record<string, unknown>): Promise<void>
            }
          >
          close(): Promise<void>
        }>
      }
    }
    const browser = await chromium.launch()
    return {
      async tab() {
        const page = await browser.newPage({ viewport: VIEWPORT })
        await page.addInitScript(shim)
        return wrap(page, (dark) => page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' }), 'networkidle')
      },
      close: () => browser.close(),
    }
  } catch {
    /* no Playwright: Puppeteer */
  }
  try {
    const puppeteer = require('puppeteer') as PuppeteerLike
    const browser = await puppeteer.launch()
    return {
      async tab() {
        const page = await browser.newPage()
        await page.setViewport(VIEWPORT)
        await page.evaluateOnNewDocument(shim)
        return wrap(
          page,
          (dark) => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]),
          'networkidle2',
        )
      },
      close: () => browser.close(),
    }
  } catch {
    /* no Puppeteer: puppeteer-core with a Chrome already on this machine */
  }
  try {
    const puppeteer = require('puppeteer-core') as {
      launch(o: Record<string, unknown>): ReturnType<PuppeteerLike['launch']>
    }
    const executablePath = process.env.CHROME_PATH ?? INSTALLED_CHROMES.find((path) => existsSync(path))
    if (!executablePath) throw new Error('no Chrome')
    const browser = await puppeteer.launch({ executablePath, headless: true })
    return {
      async tab() {
        const page = await browser.newPage()
        await page.setViewport(VIEWPORT)
        await page.evaluateOnNewDocument(shim)
        return wrap(
          page,
          (dark) => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]),
          'networkidle2',
        )
      },
      close: () => browser.close(),
    }
  } catch {
    fail(
      'needs Playwright or Puppeteer in this project (npm i -D playwright, then npx playwright install chromium), or Chrome installed and CHROME_PATH pointing at it',
    )
  }
}

const INSTALLED_CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

function wrap(page: AnyPage, colorScheme: (dark: boolean) => Promise<void>, idle: string) {
  return {
    async open(url: string) {
      await page.goto(url, { waitUntil: idle, timeout: 45_000 })
    },
    run: (command: StoryCommand) => page.evaluate(storybookPage, command),
    async screenshot() {
      const root = await page.$(`[${CAPTURE_ROOT_ATTR}]`)
      const box = await root?.boundingBox()
      if (!root || !box || box.width * box.height > 4_000_000 || box.width < 1 || box.height < 1) return undefined
      return Buffer.from(await root.screenshot({ type: 'png' }))
    },
    colorScheme,
    close: () => page.close(),
  }
}

/* ------------------------------------------------------------------ */
/* Doop over MCP                                                       */

async function callTool(server: string, key: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(new URL('/mcp', server), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: { agent_name: 'doop-storybook', ...args } },
    }),
  })
  if (response.status === 401) fail('Doop refused the key: make one in Settings → Agent keys and pass it as DOOP_KEY')
  if (!response.ok) fail(`Doop answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const body = (await response.json()) as {
    result?: { content: { type: string; text?: string }[]; isError?: boolean }
    error?: { message: string }
  }
  if (body.error) fail(body.error.message)
  const text = body.result?.content.find((block) => block.type === 'text')?.text ?? ''
  if (body.result?.isError) fail(text)
  return text
}

interface JobAnswer {
  id: string
  state: 'running' | 'done' | 'failed'
  progress: { status: string }
  summary?: string
  error?: string
  result?: { components: { name: string; outcome: string; fidelity?: number; notes: string[] }[] }
}

async function send(server: string, key: string, canvasId: string, url: string, captures: ComponentCapture[]) {
  let answer = JSON.parse(
    await callTool(server, key, 'import_storybook', { canvas_id: canvasId, url, captures }),
  ) as JobAnswer
  while (answer.state === 'running') {
    console.log(`  … ${answer.progress.status}`)
    answer = JSON.parse(
      await callTool(server, key, 'import_storybook', { canvas_id: canvasId, job_id: answer.id }),
    ) as JobAnswer
  }
  if (answer.state === 'failed') fail(answer.error ?? 'the import failed')
  console.log(`  ${answer.summary}`)
  for (const component of answer.result?.components ?? []) {
    const fidelity = component.fidelity === undefined ? '' : ` · ${Math.round(component.fidelity * 100)}% match`
    console.log(`  ${component.outcome.padEnd(9)} ${component.name}${fidelity}`)
    for (const note of component.notes) console.log(`            ${note}`)
  }
  return answer.result?.components.some((component) => ['created', 'updated', 'unchanged'].includes(component.outcome))
}

/** Captures in requests that fit /mcp. */
function batches(captures: ComponentCapture[]): ComponentCapture[][] {
  const out: ComponentCapture[][] = [[]]
  let size = 0
  for (const capture of captures) {
    const bytes = Buffer.byteLength(JSON.stringify(capture))
    if (bytes > MAX_BATCH_BYTES) {
      console.warn(`  ${capture.name} is too large to send (${Math.round(bytes / 1e6)} MB): left out`)
      continue
    }
    if (size + bytes > MAX_BATCH_BYTES && out.at(-1)!.length) {
      out.push([])
      size = 0
    }
    out.at(-1)!.push(capture)
    size += bytes
  }
  return out.filter((batch) => batch.length)
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */

async function readComponents(raw: string): Promise<{ base: URL; components: StorybookComponent[] }> {
  const base = storybookBase(raw)
  for (const file of ['index.json', 'stories.json']) {
    const response = await fetch(new URL(file, base)).catch(() => null)
    if (response?.ok) return { base, components: groupComponents(parseStoryIndex(await response.json())) }
  }
  fail(`no Storybook index at ${base.href}: is Storybook running there?`)
}

async function main() {
  const [command, url, ...args] = process.argv.slice(2)
  if (!command || !url || !['list', 'push'].includes(command)) {
    console.log('usage: doop-storybook list <storybook url>')
    console.log(
      '       DOOP_KEY=… doop-storybook push <storybook url> --canvas <id> [--server <origin>] [--only "A,B"] [--match <regex>]',
    )
    process.exit(command ? 1 : 0)
  }
  const { base, components } = await readComponents(url)
  if (command === 'list') {
    for (const component of components)
      console.log(
        `${component.title}\t${component.stories.length} stories${component.codePath ? `\t${component.codePath}` : ''}`,
      )
    return
  }
  const canvasId = flag(args, '--canvas') ?? fail('pass --canvas <id> (the canvas’s id is in its URL: /c/<id>)')
  const key = process.env.DOOP_KEY ?? flag(args, '--key') ?? fail('pass an agent key as DOOP_KEY')
  const server = flag(args, '--server') ?? 'https://doop.design'
  const only = flag(args, '--only')
    ?.split(',')
    .map((title) => title.trim())
  const match = flag(args, '--match')
  let wanted = components
  if (only) wanted = components.filter((component) => only.includes(component.title))
  if (match) wanted = wanted.filter((component) => new RegExp(match, 'i').test(component.title))
  if (!wanted.length) fail('no components match: `list` shows their titles')
  if (wanted.length > MAX_COMPONENTS)
    fail(`${wanted.length} components: narrow to ${MAX_COMPONENTS} with --only or --match`)

  console.log(`Rendering ${wanted.length} components from ${base.href}`)
  const browser = await openBrowser()
  const captures: ComponentCapture[] = []
  try {
    for (const component of wanted) {
      const tab = await browser.tab()
      try {
        captures.push(await acquireComponent(tab, base, component, { inline: true }))
        console.log(`  rendered ${component.name}`)
      } catch (error) {
        console.warn(`  ${component.name}: ${error instanceof Error ? error.message : error}`)
      } finally {
        await tab.close()
      }
    }
  } finally {
    await browser.close()
  }
  if (!captures.length) fail('nothing could be rendered')
  console.log(`Sending to ${server}`)
  let landed = false
  for (const batch of batches(captures)) if (await send(server, key, canvasId, base.href, batch)) landed = true
  if (!landed) fail('no components were synchronized')
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
