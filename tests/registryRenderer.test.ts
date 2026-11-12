import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import type { TestBrowser } from './browser.ts'
import { openBrowser } from './browser.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))
const browserMock = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../server/screenshot.ts', async (original) => ({
  ...(await original<typeof import('../server/screenshot.ts')>()),
  openIsolatedPage: browserMock.open,
}))
import { bundleRegistryComponent, renderRegistryComponent } from '../server/registryRenderer.ts'
import { createComponentFromHtml, insertInstance } from '../server/componentActions.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import type { RegistryItem } from '../server/shadcnRegistry.ts'
import type { Actor } from '../shared/types.ts'

const actor: Actor = { name: 'Importer', kind: 'user', color: '#111' }
const button: RegistryItem = {
  name: 'button',
  type: 'registry:ui',
  cssVars: { light: { primary: 'rgb(80, 40, 160)' } },
  files: [
    {
      path: 'registry/ui/button.tsx',
      content: `import {cn} from '@/lib/utils'
export function Button({children}) { return <button className={cn('bg-primary text-primary-foreground rounded-md px-4 py-2')}>{children}</button> }`,
    },
  ],
}

it('refuses source imports from the server filesystem or Node builtins', async () => {
  for (const target of ['node:fs', '/etc/passwd', '../../package.json']) {
    const bad = {
      ...button,
      files: [
        { path: 'button.tsx', content: `import x from ${JSON.stringify(target)}; export default () => <div>{x}</div>` },
      ],
    }
    await expect(bundleRegistryComponent(bad, [bad])).rejects.toThrow()
  }
})

it('resolves source dependencies and aliases without installing packages', async () => {
  const card: RegistryItem = {
    name: 'demo',
    type: 'registry:block',
    files: [
      {
        path: 'registry/demo.tsx',
        content: `import {Button} from '@/components/ui/button'; export default function Demo(){return <Button>Continue</Button>}`,
      },
    ],
  }
  const bundle = await bundleRegistryComponent(card, [card, button])
  expect(bundle.javascript).toContain('Continue')
  expect(bundle.javascript).not.toContain('https://esm.sh')
})

describe.skipIf(!inject('browserRig'))('registry rendering and component registration', () => {
  let browser: TestBrowser
  beforeAll(async () => {
    browser = await openBrowser()
    browserMock.open.mockImplementation(async () => {
      const page = await browser.newPage()
      return { page, close: () => page.close() }
    })
  })
  afterAll(async () => browser?.close())

  it('renders React to passive HTML, registers a component and preserves its styles when inserted', async () => {
    const rendered = await renderRegistryComponent(button, [button])
    expect(rendered.html).toContain('<button')
    expect(rendered.html).toContain('Button')
    expect(rendered.html).not.toContain('<script')
    expect(rendered.width).toBeLessThan(300)
    const canvas = store.createCanvas('Registry rendering')
    const component = createComponentFromHtml(canvas.id, rendered, actor)
    expect(store.getComponents(canvas.id).map((entry) => entry.id)).toContain(component.id)
    expect(component.code).toEqual({ path: 'registry/ui/button.tsx', name: 'Button' })
    expect(canvas.pages?.find((entry) => entry.name === 'Components')).toBeDefined()
    const frame = actions.createFrame(
      canvas.id,
      { name: 'Use button', html: '<html><head></head><body></body></html>' },
      actor,
    )!
    insertInstance(canvas.id, { component: component.id, frameId: frame.id }, actor)
    const page = await browser.newPage()
    try {
      await page.setContent(store.getFrame(frame.id)!.html)
      const style = await page.$eval('button', (element) => {
        const css = getComputedStyle(element)
        return { background: css.backgroundColor, padding: css.paddingLeft, radius: css.borderRadius }
      })
      expect(style.background).toBe('rgb(80, 40, 160)')
      expect(style.padding).toBe('16px')
      expect(style.radius).not.toBe('0px')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('renders primitive providers and captures portaled content as part of the component', async () => {
    const dialog: RegistryItem = {
      name: 'dialog',
      type: 'registry:ui',
      files: [
        {
          path: 'dialog.tsx',
          content: `
import * as Primitive from '@radix-ui/react-dialog'
export const Dialog = Primitive.Root
export const DialogTrigger = Primitive.Trigger
export const DialogTitle = Primitive.Title
export const DialogDescription = Primitive.Description
export function DialogContent({children}) { return <Primitive.Portal><Primitive.Content>{children}</Primitive.Content></Primitive.Portal> }
`,
        },
      ],
    }
    const rendered = await renderRegistryComponent(dialog, [dialog])
    expect(rendered.html).toContain('role="dialog"')
    expect(rendered.html).toContain('Component preview')
    expect(rendered.html).toContain('Dialog')
  }, 30_000)

  it('preserves local dependency markup and strips executable markup from the saved snapshot', async () => {
    const demo: RegistryItem = {
      name: 'demo',
      type: 'registry:block',
      files: [
        {
          path: 'demo.tsx',
          content: `import {Button} from '@/components/ui/button';
export default function Demo(){return <section><Button>Continue</Button><div dangerouslySetInnerHTML={{__html:'<script>window.pwned=true</script><a href="javascript:alert(1)" onclick="alert(1)">Link</a><iframe src="http://127.0.0.1"></iframe>'}} /></section>}`,
        },
      ],
    }
    const rendered = await renderRegistryComponent(demo, [demo, button])
    expect(rendered.html).toContain('Continue')
    expect(rendered.html).toContain('Link')
    expect(rendered.html).not.toMatch(/<script|<iframe|onclick|javascript:/i)
  }, 30_000)
})
