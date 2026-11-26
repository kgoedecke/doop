import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/*
 * The doop CLI as an agent runs it: built to public/cli, signed in with an agent key, working
 * in a linked directory against a real server.
 */

const run = promisify(execFile)

interface Ran {
  stdout: string
  stderr: string
  code: number
}

describe('the doop CLI', () => {
  let server: Server
  let owner: Client
  let secret = ''
  let home = ''
  let work = ''

  /** Runs the built CLI in `cwd`; a failing exit is an answer here, not an exception. */
  async function doop(args: string[], cwd = work, env: Record<string, string> = {}): Promise<Ran> {
    try {
      const { stdout, stderr } = await run('node', [join(process.cwd(), 'public/cli/doop.mjs'), ...args], {
        cwd,
        env: { ...process.env, DOOP_CONFIG_DIR: home, DOOP_SERVER: server.base, DOOP_AGENT_NAME: 'Tester', ...env },
        timeout: 60_000,
      })
      return { stdout, stderr, code: 0 }
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number }
      if (typeof failed.code !== 'number') throw error
      return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code }
    }
  }

  async function json<T>(args: string[], cwd = work): Promise<T> {
    const ran = await doop([...args, '--json'], cwd)
    return (JSON.parse(ran.stdout) as { data: T }).data
  }

  beforeAll(async () => {
    await run('node', ['scripts/build-doop-cli.mjs'])
    server = await startServer()
    owner = await new Client(server).signUp('doop-cli@test.dev', 'CLI Owner')
    secret = ((await (await owner.post('/api/agent-keys', { name: 'CLI' })).json()) as { secret: string }).secret
    home = mkdtempSync(join(tmpdir(), 'doop-cli-home-'))
    work = mkdtempSync(join(tmpdir(), 'doop-cli-work-'))
  }, 90_000)

  afterAll(async () => {
    for (const dir of [home, work]) if (dir) rmSync(dir, { recursive: true, force: true })
    await server?.stop()
  })

  it('says what to do when there is no key, and signs in with one', async () => {
    const anonymous = await doop(['canvases'])
    expect(anonymous.code).toBe(4)
    expect(anonymous.stderr).toContain('run `doop login`')

    const refused = await doop(['login', '--key', 'dpk_notARealKeyAtAllNotARealKeyAtAll'])
    expect(refused.code).toBe(4)

    const signedIn = await doop(['login', '--key', secret])
    expect(signedIn.stdout).toContain(`signed in to ${server.base} as CLI Owner`)
    expect((await doop(['whoami'])).stdout).toContain('CLI Owner')
    /* a new key is checked as given, not passed over for the one already saved */
    expect((await doop(['login', '--key', 'dpk_notARealKeyAtAllNotARealKeyAtAll'])).code).toBe(4)
    expect((await doop(['whoami'])).stdout).toContain('CLI Owner')
  })

  /** Runs `doop login` with no key and no browser to open (BROWSER=none: the test is the
   *  browser), and answers the sign-in link it printed and how it ended. */
  async function startLogin(config: string, env: Record<string, string> = {}) {
    const child = spawn('node', [join(process.cwd(), 'public/cli/doop.mjs'), 'login'], {
      cwd: config,
      env: {
        ...process.env,
        DOOP_CONFIG_DIR: config,
        DOOP_SERVER: server.base,
        DOOP_API_KEY: '',
        BROWSER: 'none',
        CI: '',
        ...env,
      },
    })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    const ended = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
      child.on('close', (code) => resolve({ code, stdout, stderr })),
    )
    const link = new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no sign-in link printed: ${stderr}`)), 20_000)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        const found = /https?:\/\/\S+\/cli\/connect\?\S+/.exec(stderr)
        if (!found) return
        clearTimeout(timer)
        resolve(new URL(found[0]))
      })
    })
    return { link, ended }
  }

  /** What the approval page does when the signed-in person presses Connect. */
  async function approve(link: URL): Promise<string> {
    const approved = await owner.post('/api/cli/connect', Object.fromEntries(link.searchParams))
    return ((await approved.json()) as { url: string }).url
  }

  const cliKeys = async () =>
    ((await (await owner.get('/api/agent-keys')).json()) as { name: string }[])
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('doop CLI on '))

  it('signs in through the browser: the person approves, the CLI is handed a key', async () => {
    const config = mkdtempSync(join(tmpdir(), 'doop-cli-browser-'))
    const quiet = { DOOP_CONFIG_DIR: config, DOOP_API_KEY: '' }
    try {
      const first = await startLogin(config)
      const link = await first.link
      expect(link.origin).toBe(server.base)

      /* something else on the machine finding the port is not the approval */
      const port = link.searchParams.get('port')
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=${'0'.repeat(32)}`)).status).toBe(400)

      expect(await (await fetch(await approve(link))).text()).toContain('Signed in.')
      const done = await first.ended
      expect(done.code).toBe(0)
      expect(done.stdout).toContain(`signed in to ${server.base} as CLI Owner`)
      expect((await doop(['whoami'], config, quiet)).stdout).toContain('CLI Owner')
      expect(await cliKeys()).toHaveLength(1)

      /* signing in again replaces this machine's key: the old one does not gather in Settings */
      const second = await startLogin(config)
      await fetch(await approve(await second.link))
      expect((await second.ended).code).toBe(0)
      expect(await cliKeys()).toHaveLength(1)
      expect((await doop(['whoami'], config, quiet)).stdout).toContain('CLI Owner')

      /* signing out deletes the key that sign-in made, and leaves the one the person brought */
      const out = await doop(['logout'], config, quiet)
      expect(out.stdout).toContain("this machine's key is deleted")
      expect(await cliKeys()).toHaveLength(0)
      expect(
        ((await (await owner.get('/api/agent-keys')).json()) as { name: string }[]).map((entry) => entry.name),
      ).toContain('CLI')
    } finally {
      rmSync(config, { recursive: true, force: true })
    }
  }, 90_000)

  it('does not tell the browser it worked when the server refuses the code, and does not wait in CI', async () => {
    const config = mkdtempSync(join(tmpdir(), 'doop-cli-refused-'))
    try {
      const login = await startLogin(config)
      const link = await login.link
      /* the right state, a code the server never issued */
      const callback = `http://127.0.0.1:${link.searchParams.get('port')}/callback?code=made-up&state=${link.searchParams.get('state')}`
      expect(await (await fetch(callback)).text()).toContain('That did not work.')
      const done = await login.ended
      expect(done.code).toBe(4)
      expect(done.stderr).toContain('this sign-in expired')
      expect(await cliKeys()).toHaveLength(0)

      /* nobody is there to approve in a pipeline: it says so at once */
      const started = Date.now()
      const inCi = await doop(['login'], config, { DOOP_CONFIG_DIR: config, DOOP_API_KEY: '', CI: 'true' })
      expect(inCi.code).toBe(4)
      expect(inCi.stderr).toContain('DOOP_API_KEY')
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      rmSync(config, { recursive: true, force: true })
    }
  }, 60_000)

  it('links a directory to a new canvas', async () => {
    const linked = await doop(['link', '--create', 'From the shell'])
    expect(linked.stdout).toContain('linked this directory to "From the shell"')
    const config = JSON.parse(readFileSync(join(work, '.doop/config.json'), 'utf8')) as Record<string, string>
    expect(config).toMatchObject({ name: 'From the shell', dir: 'designs', server: server.base })
    expect(readFileSync(join(work, '.doop/.gitignore'), 'utf8')).toContain('state.json')
    expect((await doop(['canvases'])).stdout).toContain('From the shell')
  })

  it('pushes a new file as a frame', async () => {
    mkdirSync(join(work, 'designs'))
    const file = join(work, 'designs/hero.html')
    writeFileSync(file, '<main><h1>Hello</h1><p>From a file</p></main>')
    const pushed = await doop(['push', 'designs/hero.html', '--width', '800', '--height', '600'])
    expect(pushed.code).toBe(0)
    expect(pushed.stdout).toMatch(/created\s+designs\/hero\.html → Hero/)
    expect(pushed.stdout).toContain('next: doop screenshot designs/hero.html')
    expect(readFileSync(file, 'utf8')).toContain('<h1>Hello</h1>')

    const { frames } = await json<{ frames: { name: string; size: string; file: string }[] }>(['frames'])
    expect(frames).toEqual([expect.objectContaining({ name: 'Hero', size: '800×600', file: 'designs/hero.html' })])
    expect((await doop(['push'])).stdout).toContain('nothing to push')
  })

  it('pushes an edit', async () => {
    const file = join(work, 'designs/hero.html')
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, before.replace('Hello', 'Hello again'))
    expect((await doop(['diff'])).stdout).toContain('+')
    const pushed = await doop(['push'])
    expect(pushed.stdout).toMatch(/pushed\s+designs\/hero\.html/)
    const { frames } = await json<{ frames: { id: string }[] }>(['frames'])
    const { result } = await json<{ result: { html: string } }>(['call', 'get_frame', `frame_id=${frames[0]!.id}`])
    expect(result.html).toContain('Hello again')
    expect(result.html).toBe(readFileSync(file, 'utf8'))
    expect((await doop(['diff'])).stdout).toContain('no differences')
  })

  it('refuses to overwrite a frame that changed on the canvas', async () => {
    const file = join(work, 'designs/hero.html')
    const { frames } = await json<{ frames: { id: string }[] }>(['frames'])
    const id = frames[0]!.id
    writeFileSync(join(work, 'theirs.html'), '<main><h1>Changed on the canvas</h1></main>')
    expect((await doop(['call', 'set_frame_html', `frame_id=${id}`, 'html@=theirs.html'])).code).toBe(0)

    writeFileSync(file, readFileSync(file, 'utf8').replace('Hello again', 'Mine'))
    const conflict = await doop(['push'])
    expect(conflict.code).toBe(3)
    expect(conflict.stdout).toContain('conflict')
    expect(conflict.stdout).toContain('doop pull designs/hero.html --force')
    /* a plain pull keeps the local edit and says so */
    expect((await doop(['pull'])).code).toBe(3)
    expect(readFileSync(file, 'utf8')).toContain('Mine')

    expect((await doop(['pull', 'designs/hero.html', '--force'])).stdout).toMatch(/pulled\s+designs\/hero\.html/)
    expect(readFileSync(file, 'utf8')).toContain('Changed on the canvas')
  })

  it('treats an element id stamped for a comment as a canvas change, so a push cannot strip it', async () => {
    const file = join(work, 'designs/hero.html')
    const { frames } = await json<{ frames: { id: string }[] }>(['frames'])
    /* an agent's rewrite plays back for the people watching, and a stamp waits for that to end */
    await expect
      .poll(
        async () =>
          (
            await owner.post(`/api/frames/${frames[0]!.id}/element-id`, {
              selector: 'body > main:nth-of-type(1) > h1:nth-of-type(1)',
            })
          ).status,
        { timeout: 45_000, interval: 500 },
      )
      .toBe(200)

    const mine = readFileSync(file, 'utf8')
    writeFileSync(file, mine.replace('Changed on the canvas', 'Edited from the older file'))
    expect((await doop(['push'])).code).toBe(3)

    writeFileSync(file, mine)
    expect((await doop(['pull'])).stdout).toMatch(/pulled\s+designs\/hero\.html/)
    expect(readFileSync(file, 'utf8')).toContain('data-doop-id')
  }, 60_000)

  it('still pushes when the frame was only renamed on the canvas, and warns of a missing component', async () => {
    const file = join(work, 'designs/hero.html')
    const { frames } = await json<{ frames: { id: string }[] }>(['frames'])
    expect((await doop(['call', 'update_frame', `frame_id=${frames[0]!.id}`, 'name=Hero'])).code).toBe(0)
    /* the frame's version moved, its HTML did not: not a conflict */
    writeFileSync(file, readFileSync(file, 'utf8').replace('Changed on the canvas', 'After a rename'))
    const pushed = await doop(['push'])
    expect(pushed.code).toBe(0)
    expect(pushed.stdout).toMatch(/pushed\s+designs\/hero\.html/)

    writeFileSync(join(work, 'designs/ghost.html'), '<main><doop-use component="Ghost"></doop-use></main>')
    const ghost = await doop(['push', 'designs/ghost.html'])
    expect(ghost.code).toBe(0)
    expect(ghost.stdout.split('\n')[0]).toBe('warning: no component “Ghost” on this canvas')
    const listed = await json<{ frames: { id: string; name: string }[] }>(['frames'])
    const ghostId = listed.frames.find((frame) => frame.name === 'Ghost')!.id
    expect((await doop(['call', 'delete_frame', `frame_id=${ghostId}`])).code).toBe(0)
    /* a frame deleted on the canvas does not fail the pull: its file stays, untracked */
    const pulled = await doop(['pull'])
    expect(pulled.code).toBe(0)
    expect(pulled.stdout).toMatch(/gone\s+designs\/ghost\.html/)
    expect(existsSync(join(work, 'designs/ghost.html'))).toBe(true)
    rmSync(join(work, 'designs/ghost.html'))
  })

  it('pulls a canvas into another checkout by its URL', async () => {
    const other = mkdtempSync(join(tmpdir(), 'doop-cli-other-'))
    try {
      const canvasId = (JSON.parse(readFileSync(join(work, '.doop/config.json'), 'utf8')) as { canvas: string }).canvas
      expect((await doop(['link', `${server.base}/c/${canvasId}`, '--dir', 'ui'], other)).code).toBe(0)
      const pulled = await doop(['pull'], other)
      expect(pulled.stdout).toMatch(/pulled\s+ui\/hero\.html\s+\(Hero, 800×600\)/)
      expect(readFileSync(join(other, 'ui/hero.html'), 'utf8')).toBe(
        readFileSync(join(work, 'designs/hero.html'), 'utf8'),
      )
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('sends only the tokens that differ, and writes them back as CSS', async () => {
    const tokens = [
      { name: '--color-primary', type: 'color', value: '#0177d3', themes: { dark: '#4aa8ff' } },
      { name: '--spacing-md', type: 'spacing', value: '16px' },
    ]
    writeFileSync(join(work, 'tokens.json'), JSON.stringify({ tokens }))
    expect((await doop(['tokens', 'push', 'tokens.json'])).stdout).toContain(
      '2 created, 0 updated, 0 deleted, 0 unchanged',
    )
    expect((await doop(['tokens', 'push', 'tokens.json'])).stdout).toContain(
      '0 created, 0 updated, 0 deleted, 2 unchanged',
    )

    tokens[1]!.value = '20px'
    writeFileSync(join(work, 'tokens.json'), JSON.stringify({ tokens: [tokens[1]] }))
    expect((await doop(['tokens', 'push', 'tokens.json', '--prune'])).stdout).toContain(
      '0 created, 1 updated, 1 deleted, 0 unchanged',
    )
    await doop(['tokens', 'pull', '--format', 'css', '-o', 'src/tokens.css'])
    const css = readFileSync(join(work, 'src/tokens.css'), 'utf8')
    expect(css).toContain('--spacing-md:20px')
    expect(css).not.toContain('--color-primary')

    /* an entry that states only a value leaves the token's type alone, push after push */
    writeFileSync(join(work, 'tokens.json'), JSON.stringify({ tokens: [{ name: '--spacing-md', value: '20px' }] }))
    expect((await doop(['tokens', 'push', 'tokens.json'])).stdout).toContain(
      '0 created, 0 updated, 0 deleted, 1 unchanged',
    )
  })

  it('keeps components as files, and frames that use them in the short form', async () => {
    mkdirSync(join(work, 'designs/components'))
    const html = join(work, 'designs/components/badge.html')
    const css = join(work, 'designs/components/badge.css')
    writeFileSync(html, '<span class="badge" data-doop-prop="label">New</span>')
    writeFileSync(css, '.badge { background: #0177d3; color: #fff; padding: 4px 8px; }')
    const created = await doop(['push', 'designs/components/badge.html'])
    expect(created.stdout).toMatch(
      /created\s+designs\/components\/badge\.\{html,css,json\} → component Badge, revision \d+/,
    )
    /* the canvas keys the template's elements, and the files take what it stored */
    expect(readFileSync(html, 'utf8')).toContain('data-doop-part')
    const meta = JSON.parse(readFileSync(join(work, 'designs/components/badge.json'), 'utf8')) as { name: string }
    expect(meta.name).toBe('Badge')
    expect((await doop(['push'])).stdout).toContain('nothing to push')

    const { result } = await json<{ result: { components: { name: string; usage: string }[] } }>([
      'call',
      'list_components',
    ])
    const usage = result.components.find((entry) => entry.name === 'Badge')!.usage
    expect(usage).toContain('<doop-use')
    writeFileSync(join(work, 'designs/card.html'), `<main><h2>Card</h2>${usage}</main>`)
    expect((await doop(['push', 'designs/card.html', '--width', '400', '--height', '300'])).code).toBe(0)
    /* the frame's file stays a reference to the component */
    const card = readFileSync(join(work, 'designs/card.html'), 'utf8')
    expect(card).toContain('<doop-use')
    expect(card).not.toContain('class="badge"')
  })

  it('writes a frame out in full for reading, and never pushes that file', async () => {
    const expanded = await doop(['expand', 'designs/card.html'])
    expect(expanded.stdout).toContain('.doop/expanded/card.html')
    const page = readFileSync(join(work, '.doop/expanded/card.html'), 'utf8')
    expect(page).toContain('Generated by `doop expand`')
    expect(page).toContain('designs/card.html')
    expect(page).toContain('class="badge"')
    expect(page).toContain('#0177d3')
    expect(page).not.toContain('<doop-use')

    const refused = await doop(['push', '.doop/expanded/card.html'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('is generated by the CLI')
  })

  it('pushes a component edit against the revision it came from', async () => {
    const css = join(work, 'designs/components/badge.css')
    writeFileSync(css, readFileSync(css, 'utf8').replace('#0177d3', '#111111'))
    const pushed = await doop(['push'])
    expect(pushed.stdout).toMatch(/pushed\s+designs\/components\/badge/)
    /* the frame using it follows, with no frame file changing */
    await doop(['expand', 'designs/card.html'])
    expect(readFileSync(join(work, '.doop/expanded/card.html'), 'utf8')).toContain('#111111')
    expect((await doop(['push'])).stdout).toContain('nothing to push')

    writeFileSync(join(work, 'theirs.css'), '.badge { background: #ff0000; }')
    expect((await doop(['call', 'update_component', 'component=Badge', 'css@=theirs.css'])).code).toBe(0)
    writeFileSync(css, readFileSync(css, 'utf8').replace('#111111', '#222222'))
    const conflict = await doop(['push'])
    expect(conflict.code).toBe(3)
    expect(conflict.stdout).toMatch(/conflict\s+designs\/components\/badge/)
    expect((await doop(['pull'])).code).toBe(3)
    expect(readFileSync(css, 'utf8')).toContain('#222222')

    expect((await doop(['pull', 'designs/components/badge.css', '--force'])).code).toBe(0)
    expect(readFileSync(css, 'utf8')).toContain('#ff0000')

    /* a CSS edit outlives its template file going missing: with the canvas unchanged, the pull
       puts the template back beside the edit, and the edit can be pushed */
    const template = join(work, 'designs/components/badge.html')
    /* a change made and undone on the canvas moves its revision, not what it holds */
    writeFileSync(join(work, 'blue.css'), '.badge { background: #0000ff; }')
    expect((await doop(['call', 'update_component', 'component=Badge', 'css@=blue.css'])).code).toBe(0)
    expect((await doop(['call', 'update_component', 'component=Badge', 'css@=theirs.css'])).code).toBe(0)
    writeFileSync(css, readFileSync(css, 'utf8').replace('#ff0000', '#333333'))
    rmSync(template)
    const kept = await doop(['pull'])
    expect(kept.code).toBe(0)
    expect(kept.stdout).toMatch(/local changes kept\s+designs\/components\/badge/)
    expect(readFileSync(css, 'utf8')).toContain('#333333')
    expect(existsSync(template)).toBe(true)
    expect((await doop(['push'])).stdout).toMatch(/pushed\s+designs\/components\/badge/)
    writeFileSync(css, readFileSync(css, 'utf8').replace('#333333', '#444444'))

    /* with the canvas changed as well, it is a conflict, and the way out does not push a missing file */
    writeFileSync(join(work, 'theirs.css'), '.badge { background: #00ff00; }')
    expect((await doop(['call', 'update_component', 'component=Badge', 'css@=theirs.css'])).code).toBe(0)
    rmSync(template)
    const missing = await doop(['pull'])
    expect(missing.code).toBe(3)
    expect(missing.stdout).toContain('designs/components/badge.html is missing')
    expect(readFileSync(css, 'utf8')).toContain('#444444')
    expect(existsSync(template)).toBe(false)
    expect((await doop(['pull', 'designs/components/badge.css', '--force'])).code).toBe(0)
    expect(readFileSync(css, 'utf8')).toContain('#00ff00')
    expect(existsSync(template)).toBe(true)
  })

  it('pulls components into a fresh checkout as components, not as their main frames', async () => {
    const other = mkdtempSync(join(tmpdir(), 'doop-cli-other-'))
    try {
      const canvasId = (JSON.parse(readFileSync(join(work, '.doop/config.json'), 'utf8')) as { canvas: string }).canvas
      const linked = await doop(['link', canvasId], other)
      expect(linked.code, linked.stdout + linked.stderr).toBe(0)
      const pulled = await doop(['pull'], other)
      expect(pulled.stdout).toMatch(/pulled\s+designs\/components\/badge\.\{html,css,json\}/)
      expect(pulled.stdout).toMatch(/pulled\s+designs\/card\.html/)
      expect(existsSync(join(other, 'designs/components/badge.css'))).toBe(true)
      /* the component's main is a frame on the canvas; it is not pulled a second time as one */
      expect(existsSync(join(other, 'designs/badge.html'))).toBe(false)
      expect(pulled.stdout.match(/^pulled/gm)).toHaveLength(3)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('refuses to push a component description over one changed on the canvas', async () => {
    const file = join(work, 'designs/components/badge.json')
    const mine = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect((await doop(['call', 'update_component', 'component=Badge', 'description=Theirs'])).code).toBe(0)
    writeFileSync(file, JSON.stringify({ ...mine, description: 'Mine' }, null, 2))
    const conflict = await doop(['push'])
    expect(conflict.code).toBe(3)
    expect(conflict.stdout).toMatch(/conflict\s+designs\/components\/badge/)
    const { result } = await json<{ result: { description?: string } }>(['call', 'get_component', 'component=Badge'])
    expect(result.description).toBe('Theirs')

    expect((await doop(['pull', 'designs/components/badge.json', '--force'])).code).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ description: 'Theirs' })
    expect((await doop(['push'])).stdout).toContain('nothing to push')
  })

  it('uploads a local image and prints its URL', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(join(work, 'dot.png'), png)
    const { assets } = await json<{ assets: { url: string; source: string }[] }>(['asset', 'upload', 'dot.png'])
    expect(assets[0]!.url).toMatch(/\/a\/[\w-]+\.png$/)
    expect((await fetch(assets[0]!.url)).status).toBe(200)
  })

  it('waits for a person, and times out when nobody comes', async () => {
    const quiet = await doop(['wait', '--timeout', '1s', '--interval', '1s'])
    expect(quiet.code).toBe(6)

    const { canvas } = await json<{ canvas: { id: string; pages: { id: string }[] } }>(['frames'])
    const waiting = doop(['wait', '--comments', '--timeout', '30s', '--interval', '1s', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const posted = await owner.post(`/api/canvases/${canvas.id}/comments`, {
      pageId: canvas.pages[0]!.id,
      x: 10,
      y: 10,
      text: 'Make the headline bigger',
    })
    expect(posted.status).toBe(200)
    const heard = await waiting
    expect(heard.code).toBe(0)
    const { comments } = (JSON.parse(heard.stdout) as { data: { comments: { from: string; text: string }[] } }).data
    expect(comments).toEqual([expect.objectContaining({ from: 'CLI Owner', text: 'Make the headline bigger' })])

    /* a comment left while the agent was working is what the next wait starts with */
    await owner.post(`/api/canvases/${canvas.id}/comments`, {
      pageId: canvas.pages[0]!.id,
      x: 20,
      y: 20,
      text: 'And the button too',
    })
    const next = await doop(['wait', '--comments', '--timeout', '10s', '--interval', '1s'])
    expect(next.code).toBe(0)
    expect(next.stdout).toContain('And the button too')
    expect(next.stdout).not.toContain('Make the headline bigger')
  }, 60_000)

  it('keeps what a push tracked while a wait runs beside it', async () => {
    const { canvas } = await json<{ canvas: { id: string; pages: { id: string }[] } }>(['frames'])
    const waiting = doop(['wait', '--comments', '--timeout', '30s', '--interval', '1s'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    writeFileSync(join(work, 'designs/sidebar.html'), '<aside>Pushed while waiting</aside>')
    expect((await doop(['push', 'designs/sidebar.html'])).stdout).toMatch(/created\s+designs\/sidebar\.html/)
    await owner.post(`/api/canvases/${canvas.id}/comments`, {
      pageId: canvas.pages[0]!.id,
      x: 30,
      y: 30,
      text: 'Seen while you pushed',
    })
    expect((await waiting).stdout).toContain('Seen while you pushed')

    /* the wait saved its comment mark, not the state it read before the push */
    const state = JSON.parse(readFileSync(join(work, '.doop/state.json'), 'utf8')) as {
      frames: Record<string, unknown>
    }
    expect(Object.keys(state.frames)).toContain('designs/sidebar.html')
    expect((await doop(['push'])).stdout).toContain('nothing to push')
  }, 60_000)

  it('starts a wait on a relinked canvas from that canvas, not from the comment mark of the last one', async () => {
    const other = mkdtempSync(join(tmpdir(), 'doop-cli-relink-'))
    try {
      const canvasId = (JSON.parse(readFileSync(join(work, '.doop/config.json'), 'utf8')) as { canvas: string }).canvas
      await doop(['link', canvasId], other)
      /* the first canvas has comments: a quiet wait marks the newest of them */
      expect((await doop(['wait', '--comments', '--timeout', '1s', '--interval', '1s'], other)).code).toBe(6)

      expect((await doop(['link', '--create', 'Relinked'], other)).code).toBe(0)
      const { canvas } = await json<{ canvas: { id: string; pages: { id: string }[] } }>(['frames'], other)
      await owner.post(`/api/canvases/${canvas.id}/comments`, {
        pageId: canvas.pages[0]!.id,
        x: 10,
        y: 10,
        text: 'Here before the wait',
      })
      const quiet = await doop(['wait', '--comments', '--timeout', '2s', '--interval', '1s'], other)
      expect(quiet.code).toBe(6)
      expect(quiet.stdout).not.toContain('Here before the wait')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  }, 60_000)

  it('reaches every MCP tool, with the canvas filled in', async () => {
    const listed = await doop(['tools'])
    expect(listed.stdout).toContain('get_canvas\t')
    expect((await doop(['tools', 'set_status'])).stdout).toContain('"status"')
    expect((await doop(['tools', 'no_such_tool'])).code).toBe(5)

    expect((await doop(['status', 'Trying the CLI'])).stdout).toContain('status: Trying the CLI')
    const { result } = await json<{ result: { name: string } }>(['call', 'get_canvas'])
    expect(result.name).toBe('From the shell')
    expect((await doop(['frames', '--canvas', 'nope'])).code).toBe(5)

    const guide = await doop(['guide'])
    expect(guide.stdout).toContain('# Doop from the command line')
    expect(guide.stdout.length).toBeGreaterThan(3000)
  })

  it('tells the repository’s agents about Doop, once', async () => {
    writeFileSync(join(work, 'AGENTS.md'), '# Agents\n\nUse bun.\n')
    expect((await doop(['init', '--skill'])).stdout).toContain('wrote AGENTS.md and .claude/skills/doop/SKILL.md')
    const agents = readFileSync(join(work, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('Use bun.')
    expect(agents.match(/doop:start/g)).toHaveLength(1)
    expect(existsSync(join(work, '.claude/skills/doop/SKILL.md'))).toBe(true)
    expect((await doop(['init'])).stdout).toContain('already set up')
    expect(readFileSync(join(work, 'AGENTS.md'), 'utf8')).toBe(agents)
  })

  it('sends a key from the environment only to a server its holder named', async () => {
    /* this directory's config names the test server; nothing else does */
    const fresh = mkdtempSync(join(tmpdir(), 'doop-cli-nokey-'))
    try {
      const loose = { DOOP_SERVER: '', DOOP_API_KEY: secret, DOOP_CONFIG_DIR: fresh }
      const refused = await doop(['frames'], work, loose)
      expect(refused.code).toBe(4)
      expect(refused.stderr).toContain('the agent key was not sent')
      expect(refused.stderr).toContain(`DOOP_SERVER=${server.base}`)
      const canvasId = (JSON.parse(readFileSync(join(work, '.doop/config.json'), 'utf8')) as { canvas: string }).canvas
      expect((await doop(['link', `${server.base}/c/${canvasId}`], fresh, loose)).code).toBe(4)
      /* a key saved for that server by `doop login` is another matter: it belongs there */
      expect((await doop(['frames'], work, { DOOP_SERVER: '' })).code).toBe(0)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('keeps a linked directory on its canvas and its files', async () => {
    const mixed = await doop(['pull', '--canvas', 'another-canvas'])
    expect(mixed.code).toBe(2)
    expect(mixed.stderr).toContain('the canvas this directory is linked to')

    /* a stylesheet deleted here is not an empty stylesheet for every instance */
    const css = join(work, 'designs/components/badge.css')
    const before = readFileSync(css, 'utf8')
    rmSync(css)
    expect((await doop(['push'])).stdout).toContain('nothing to push')
    expect((await doop(['pull'])).code).toBe(0)
    expect(readFileSync(css, 'utf8')).toBe(before)

    /* a component deleted on the canvas stops being tracked, and its files stay */
    writeFileSync(join(work, 'designs/components/chip.html'), '<span class="chip">Chip</span>')
    expect((await doop(['push', 'designs/components/chip.html'])).code).toBe(0)
    expect((await doop(['call', 'delete_component', 'component=Chip'])).code).toBe(0)
    const pulled = await doop(['pull'])
    expect(pulled.code).toBe(0)
    expect(pulled.stdout).toMatch(/gone\s+designs\/components\/chip/)
    expect(existsSync(join(work, 'designs/components/chip.html'))).toBe(true)
    expect((await doop(['push'])).stdout).toContain('nothing to push')

    /* a config that names a folder outside the project is refused before anything is written */
    const escaping = mkdtempSync(join(tmpdir(), 'doop-cli-escape-'))
    try {
      mkdirSync(join(escaping, '.doop'))
      const config = readFileSync(join(work, '.doop/config.json'), 'utf8')
      writeFileSync(join(escaping, '.doop/config.json'), config.replace('"designs"', '"../outside"'))
      const refused = await doop(['pull'], escaping)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('names a path outside this directory')
    } finally {
      rmSync(escaping, { recursive: true, force: true })
    }
  })

  it('says what an earlier step heard when a later one fails', async () => {
    writeFileSync(join(work, 'designs/ghost.html'), '<main><doop-use component="Ghost"></doop-use></main>')
    const failed = await doop(['push', 'designs/ghost.html', 'designs/not-there.html'])
    expect(failed.code).toBe(5)
    expect(failed.stdout).toContain('warning: no component “Ghost” on this canvas')
    expect(failed.stderr).toContain('designs/not-there.html does not exist')
  })

  it('takes key=value as text, and names the files of same-named frames apart', async () => {
    expect((await doop(['call', 'set_status', 'status=42'])).stdout).toContain('"status": "42"')
    /* text that starts with a mention is text, not a file to read */
    expect((await doop(['call', 'set_status', 'status=@Ana done'])).stdout).toContain('"status": "@Ana done"')
    expect((await doop(['call', 'set_status', 'status:=42'])).code).toBe(1)
    expect((await doop(['call', 'set_status', 'status:=forty'])).code).toBe(2)

    writeFileSync(join(work, 'designs/twin.html'), '<main>Twin</main>')
    expect((await doop(['push', 'designs/twin.html', '--name', 'Card'])).code).toBe(0)
    const { frames } = await json<{ frames: { id: string; name: string }[] }>(['frames'])
    const cards = frames.filter((frame) => frame.name === 'Card')
    expect(cards).toHaveLength(2)
    /* a directory that has pulled nothing has only the frames' names to go by */
    const bare = mkdtempSync(join(tmpdir(), 'doop-cli-bare-'))
    try {
      const canvasId = (JSON.parse(readFileSync(join(work, '.doop/config.json'), 'utf8')) as { canvas: string }).canvas
      const linked = await doop(['link', canvasId], bare)
      expect(linked.code, linked.stdout + linked.stderr).toBe(0)
      const expanded = await doop(['expand', cards[0]!.id, cards[1]!.id], bare)
      expect(expanded.code).toBe(0)
      expect(existsSync(join(bare, '.doop/expanded/card.html'))).toBe(true)
      expect(existsSync(join(bare, `.doop/expanded/card-${cards[1]!.id.slice(0, 4).toLowerCase()}.html`))).toBe(true)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it.skipIf(!findBrowserPath())(
    'writes a screenshot and an export to disk',
    async () => {
      const shot = await doop(['screenshot', 'designs/hero.html'])
      expect(shot.code).toBe(0)
      expect(shot.stdout).toContain('.doop/shots/hero.png')
      expect(readFileSync(join(work, '.doop/shots/hero.png')).subarray(1, 4).toString()).toBe('PNG')

      const exported = await doop(['export', 'Hero', '--format', 'pdf', '-o', 'out'])
      expect(exported.stdout).toContain('out/hero.pdf')
      expect(readFileSync(join(work, 'out/hero.pdf')).subarray(0, 4).toString()).toBe('%PDF')

      expect((await doop(['inspect', 'designs/hero.html'])).code).toBe(0)

      const preview = await doop(['screenshot', 'designs/components/badge.html'])
      expect(preview.stdout).toContain('.doop/shots/badge.png')
    },
    120_000,
  )
})
