import { describe, expect, it } from 'vitest'
import {
  designSystemSlug,
  extractHtml,
  nextRepoFramePosition,
  resolveImport,
  treeExcerpt,
} from '../server/githubRecon.ts'
import { wrapGeneratedHtml } from '../server/github.ts'

/** The reconstruction pass's pure core: import resolution against a repo
 *  tree, and pulling the HTML document (+ declared height) out of a model
 *  reply. The model call itself is exercised in production, not here. */

describe('resolveImport', () => {
  const paths = new Set([
    'src/pages/index.tsx',
    'src/components/Hero.tsx',
    'src/components/ui/index.ts',
    'src/styles/globals.css',
    'apps/web/src/lib/util.ts',
  ])

  it('resolves relative specifiers with extension and index probing', () => {
    expect(resolveImport('../components/Hero', 'src/pages/index.tsx', paths)).toBe('src/components/Hero.tsx')
    expect(resolveImport('../components/ui', 'src/pages/index.tsx', paths)).toBe('src/components/ui/index.ts')
    expect(resolveImport('../styles/globals.css', 'src/pages/index.tsx', paths)).toBe('src/styles/globals.css')
  })

  it('maps @/ aliases to the nearest src root', () => {
    expect(resolveImport('@/components/Hero', 'src/pages/index.tsx', paths)).toBe('src/components/Hero.tsx')
    expect(resolveImport('@/lib/util', 'apps/web/src/pages/x.tsx', paths)).toBe('apps/web/src/lib/util.ts')
  })

  it('ignores package imports and unresolvable paths', () => {
    expect(resolveImport('react', 'src/pages/index.tsx', paths)).toBeUndefined()
    expect(resolveImport('./missing', 'src/pages/index.tsx', paths)).toBeUndefined()
  })
})

describe('extractHtml', () => {
  it('takes the document from plain text and reads the height comment', () => {
    const { html, height } = extractHtml([
      { type: 'text', text: 'Here it is:\n<!doctype html><html><body>x</body></html>\n<!-- doop-height: 1240 -->' },
    ])
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(height).toBe(1240)
  })

  it('unwraps markdown fences, clamps silly heights, defaults sans comment', () => {
    const fenced = extractHtml([
      { type: 'text', text: '```html\n<!doctype html><p>x</p>\n<!-- doop-height: 99999 -->\n```' },
    ])
    expect(fenced.height).toBe(8000)
    expect(extractHtml([{ type: 'text', text: '<!doctype html><p>x</p>' }]).height).toBe(900)
    expect(() => extractHtml([{ type: 'text', text: 'sorry, no' }])).toThrow(/no HTML/)
  })
})

describe('treeExcerpt', () => {
  it('surfaces styling and locale paths, drops binaries and node_modules', () => {
    const tree = treeExcerpt(
      [
        'src/pages/backup.tsx',
        'src/styles/theme.ts',
        'public/locales/en/backup.json',
        'src/components/Nav.tsx',
        'node_modules/react/index.js',
        'public/logo.png',
        'README.md',
      ],
      'src/pages/backup.tsx',
    )
    expect(tree).toContain('src/styles/theme.ts')
    expect(tree).toContain('public/locales/en/backup.json')
    expect(tree).not.toContain('node_modules')
    /* images stay listed — they are transplantable assets now */
    expect(tree).toContain('public/logo.png')
  })
})

describe('repo asset references', () => {
  it('keeps image paths in the tree so the model can transplant them', () => {
    const tree = treeExcerpt(['public/logos/ibm.svg', 'src/pages/index.tsx'], 'src/pages/index.tsx')
    expect(tree).toContain('public/logos/ibm.svg')
  })

  it('extractHtml raises the height ceiling for full pages', () => {
    const { height } = extractHtml([{ type: 'text', text: '<!doctype html><p>x</p>\n<!-- doop-height: 6600 -->' }])
    expect(height).toBe(6600)
  })
})

describe('nextRepoFramePosition', () => {
  const CONN = 'conn-1'
  const marked = (x: number, y: number, width: number, height: number, conn = CONN) => ({
    x,
    y,
    width,
    height,
    html: wrapGeneratedHtml(
      '<html><head></head><body>x</body></html>',
      { id: conn, repo: 'a/b', branch: 'main' },
      {
        kind: 'component',
        route: 'src/Button.tsx',
        sourcePath: 'src/Button.tsx',
      },
    ),
  })
  const plain = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, html: '<p/>' })

  it('starts the import right of everything on the canvas, or at the origin on an empty one', () => {
    expect(nextRepoFramePosition([], CONN, 640)).toEqual({ x: 120, y: 120 })
    expect(nextRepoFramePosition([plain(100, 300, 1000, 500)], CONN, 640)).toEqual({ x: 1180, y: 120 })
  })

  it('flows siblings into the current row while it fits, then wraps under everything', () => {
    const frames = [plain(100, 300, 1000, 500), marked(1180, 120, 640, 420)]
    expect(nextRepoFramePosition(frames, CONN, 640)).toEqual({ x: 1900, y: 120 })
    const fullRow = [
      marked(120, 120, 1280, 900),
      marked(1480, 120, 1280, 700),
      /* a taller frame in the row decides where the next row starts */
    ]
    expect(nextRepoFramePosition(fullRow, CONN, 1280)).toEqual({ x: 120, y: 1100 })
  })

  it('only counts frames from the same connection as siblings', () => {
    const frames = [marked(120, 120, 640, 420, 'other-conn')]
    expect(nextRepoFramePosition(frames, CONN, 640)).toEqual({ x: 840, y: 120 })
  })
})

describe('designSystemSlug', () => {
  it('names the guide after the repository', () => {
    expect(designSystemSlug('acme/Web.App')).toBe('web-app-design-system')
  })
})
