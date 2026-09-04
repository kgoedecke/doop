import { describe, expect, it } from 'vitest'
import { detectFramework, detectScreens, githubFrameMarker, matchSelection, wrapRepoHtml } from '../server/github.ts'

/**
 * The GitHub import source's pure core: screen enumeration from framework
 * routing conventions, and the provenance marker round-trip through frame
 * HTML. No network, no server — the API-facing paths are thin wrappers over
 * these.
 */

const nextPkg = { dependencies: { next: '15.0.0', react: '18' } }

describe('framework detection', () => {
  it('recognizes the major stacks from dependencies', () => {
    expect(detectFramework(nextPkg)).toBe('next')
    expect(detectFramework({ devDependencies: { '@sveltejs/kit': '2' } })).toBe('sveltekit')
    expect(detectFramework({ dependencies: { astro: '4' } })).toBe('astro')
    expect(detectFramework({ dependencies: { express: '4' } })).toBeNull()
    expect(detectFramework(null)).toBeNull()
  })
})

describe('screen enumeration', () => {
  it('derives next.js app-router routes, dropping groups and slots', () => {
    const screens = detectScreens(
      [
        'app/page.tsx',
        'app/(marketing)/pricing/page.tsx',
        'app/dashboard/@modal/page.tsx',
        'app/blog/[slug]/page.tsx',
        'app/api/route.ts',
        'node_modules/somelib/app/page.tsx',
      ],
      nextPkg,
    )
    const pages = screens.filter((s) => s.kind === 'page')
    expect(pages.map((s) => s.route)).toEqual(['/', '/pricing', '/dashboard', '/blog/[slug]'])
    expect(pages.find((s) => s.route === '/blog/[slug]')!.dynamic).toBe(true)
    expect(pages.find((s) => s.route === '/')!.title).toBe('Home')
  })

  it('derives pages-router routes and skips api/_underscore files', () => {
    const screens = detectScreens(
      ['pages/index.tsx', 'pages/about.tsx', 'pages/api/hello.ts', 'pages/_app.tsx', 'pages/docs/setup.mdx'],
      nextPkg,
    )
    expect(screens.map((s) => s.route)).toEqual(['/', '/about', '/docs/setup'])
  })

  it('derives sveltekit routes', () => {
    const screens = detectScreens(['src/routes/+page.svelte', 'src/routes/settings/+page.svelte'], {
      dependencies: { '@sveltejs/kit': '2' },
    })
    expect(screens.map((s) => s.route)).toEqual(['/', '/settings'])
  })

  it('detects PascalCase component modules under components/ui dirs', () => {
    const screens = detectScreens(
      [
        'src/components/Button.tsx',
        'src/components/nav/NavBar.tsx',
        'src/ui/Card.jsx',
        'src/components/Button.test.tsx',
        'src/components/helpers.ts',
        'src/utils/Format.tsx',
      ],
      nextPkg,
    )
    expect(screens.filter((s) => s.kind === 'component').map((s) => s.title)).toEqual(['Button', 'NavBar', 'Card'])
  })

  it('sweeps storybook stories and plain html regardless of framework', () => {
    const screens = detectScreens(
      ['src/Button.stories.tsx', 'public/landing.html', 'dist/index.html', 'node_modules/x/y.html'],
      null,
    )
    expect(screens.map((s) => [s.kind, s.sourcePath])).toEqual([
      ['story', 'src/Button.stories.tsx'],
      ['static', 'public/landing.html'],
      ['static', 'dist/index.html'],
    ])
    expect(screens.every((s) => (s.kind === 'static' ? s.source === 'static' : s.source === 'placeholder'))).toBe(true)
  })
})

describe('provenance marker', () => {
  const conn = { id: 'c1', repo: 'acme/app', branch: 'main' }
  const screen = { kind: 'static' as const, route: '/public/landing.html', sourcePath: 'public/landing.html' }

  it('round-trips through wrapped repo HTML and strips active content', () => {
    const html = wrapRepoHtml(
      '<html><head><title>x</title></head><body onload="p()"><script>alert(1)</script><h1>hi</h1></body></html>',
      conn,
      screen,
    )
    expect(githubFrameMarker(html)).toEqual({ connectionId: 'c1', ...screen })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onload')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain('https://raw.githubusercontent.com/acme/app/main/public/')
  })

  it('returns undefined for unmarked frames', () => {
    expect(githubFrameMarker('<html><body>plain</body></html>')).toBeUndefined()
  })
})

describe('selection matching', () => {
  const manifest = detectScreens(['pages/index.tsx', 'pages/about.tsx', 'public/landing.html'], nextPkg)

  it('resolves picks to manifest screens, taking lane and path from the manifest', () => {
    const { screens, rejected } = matchSelection(manifest, [
      { kind: 'page', route: '/about', sourcePath: 'pages/about.tsx', source: 'placeholder' },
    ])
    expect(rejected).toEqual([])
    expect(screens).toHaveLength(1)
    expect(screens[0]).toBe(manifest.find((s) => s.route === '/about'))
  })

  it('rejects entries not in the manifest — a crafted sourcePath cannot reach the repo', () => {
    const { screens, rejected } = matchSelection(manifest, [
      { kind: 'static', route: '/.env', sourcePath: '.env', source: 'static' },
      { kind: 'static', route: '/public/landing.html', sourcePath: 'public/landing.html', source: 'static' },
    ])
    expect(screens.map((s) => s.sourcePath)).toEqual(['public/landing.html'])
    expect(rejected).toEqual(['/.env'])
  })

  it('dedupes repeated picks and enforces bounds', () => {
    const pick = { kind: 'page', route: '/', sourcePath: 'pages/index.tsx' }
    expect(matchSelection(manifest, [pick, pick]).screens).toHaveLength(1)
    expect(() => matchSelection(manifest, [])).toThrow(/at least one/)
    expect(() => matchSelection(manifest, 'nope')).toThrow(/array/)
  })
})

describe('nested monorepo roots', () => {
  it('derives routes relative to the framework root, not the repo root', () => {
    const next = detectScreens(
      ['apps/web/app/page.tsx', 'apps/web/app/settings/page.tsx', 'apps/web/pages/about.tsx'],
      nextPkg,
    )
    expect(next.map((s) => s.route)).toEqual(['/', '/settings', '/about'])
    const svelte = detectScreens(['apps/web/src/routes/settings/+page.svelte'], {
      dependencies: { '@sveltejs/kit': '2' },
    })
    expect(svelte.map((s) => s.route)).toEqual(['/settings'])
    const remix = detectScreens(['apps/web/app/routes/_index.tsx', 'apps/web/app/routes/dashboard.tsx'], {
      dependencies: { '@remix-run/react': '2' },
    })
    expect(remix.map((s) => s.route)).toEqual(['/', '/dashboard'])
  })
})

/* ---- REST surface: access rules and validation, no GitHub network calls —
   a malformed repo name fails before any fetch leaves the server. */

import { afterAll, beforeAll } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4986
let server: Server

beforeAll(async () => {
  server = await startServer(PORT)
}, 70_000)

afterAll(() => server?.stop())

describe('github connection REST', () => {
  let owner: Client
  let stranger: Client
  let canvasId: string

  beforeAll(async () => {
    owner = new Client(server)
    stranger = new Client(server)
    await owner.signUp('gh-owner@test.dev', 'Owner')
    await stranger.signUp('gh-stranger@test.dev', 'Stranger')
    const canvas = await (await owner.post('/api/canvases', { name: 'Repo' })).json()
    canvasId = canvas.id
  })

  it('members can list connections; strangers cannot', async () => {
    expect((await stranger.get(`/api/canvases/${canvasId}/github`)).status).toBe(403)
    const res = await owner.get(`/api/canvases/${canvasId}/github`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('rejects malformed repo names and missing tokens before touching GitHub', async () => {
    const bad = await owner.post(`/api/canvases/${canvasId}/github`, { repo: 'not a repo', token: 'x' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/owner\/name/)
    const noToken = await owner.post(`/api/canvases/${canvasId}/github`, { repo: 'acme/app', token: '  ' })
    expect(noToken.status).toBe(400)
  })

  it('404s analyze/import for unknown connections', async () => {
    expect((await owner.post(`/api/canvases/${canvasId}/github/nope/analyze`)).status).toBe(404)
    expect((await owner.post(`/api/canvases/${canvasId}/github/nope/import`, { screens: [] })).status).toBe(404)
    expect((await stranger.post(`/api/canvases/${canvasId}/github/nope/analyze`)).status).toBe(403)
  })
})
