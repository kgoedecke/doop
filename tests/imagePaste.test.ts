// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

/* a pasted image goes up as an asset and comes back as a canvas element:
   stub the network, and give every image the natural size its file name
   asks for, since the test DOM decodes nothing */
const api = {
  uploadAsset: vi.fn(async () => ({ url: '/a/pasted.png' })),
  createFrame: vi.fn(async (canvasId: string, rest: Partial<Frame>) => ({ ...rest, canvasId, id: 'f1' }) as Frame),
}
vi.mock('../src/lib/api', () => ({ api }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const sizes = new Map<string, { width: number; height: number }>()
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (f: File) => f.name, revokeObjectURL: () => {} }))
vi.stubGlobal(
  'Image',
  class {
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(name: string) {
      const size = sizes.get(name)
      if (size) [this.naturalWidth, this.naturalHeight] = [size.width, size.height]
      queueMicrotask(() => this.onload?.())
    }
  },
)

const { uploadImageFrames } = await import('../src/lib/frameClipboard')
const { isCanvasElement } = await import('../src/lib/drawing')
const { buildLayerTree } = await import('../src/lib/layers')

function image(name: string, width: number, height: number): File {
  sizes.set(name, { width, height })
  return new File(['png'], name, { type: 'image/png' })
}

beforeEach(() => vi.clearAllMocks())

describe('pasted images', () => {
  it('land as a top-level canvas element, not a frame', async () => {
    const [created] = await uploadImageFrames('c1', [image('Hero shot.png', 400, 300)])
    const html = created?.html ?? ''
    expect(isCanvasElement(html)).toBe(true)
    const body = new DOMParser().parseFromString(html, 'text/html').body
    expect(body.children).toHaveLength(1)
    const img = body.firstElementChild as HTMLImageElement
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toBe('/a/pasted.png')
    expect(img.getAttribute('data-doop-drawing')).toBe('image')
    expect(img.getAttribute('data-name')).toBe('Hero shot')
  })

  it('fill their shell, so resizing the element resizes the image', async () => {
    const [created] = await uploadImageFrames('c1', [image('wide.png', 1800, 900)])
    const img = new DOMParser().parseFromString(created?.html ?? '', 'text/html').querySelector('img')
    expect(img?.style.position).toBe('absolute')
    expect(img?.style.width).toBe('100%')
    expect(img?.style.height).toBe('100%')
    expect(img?.style.objectFit).toBe('contain')
    /* the shell takes the image's proportions, capped at 900px */
    expect(created).toMatchObject({ width: 900, height: 450 })
  })

  it('are one root layer named after the file', async () => {
    const [created] = await uploadImageFrames('c1', [image('logo.png', 200, 200)])
    const [only, ...more] = buildLayerTree(created?.html ?? '')
    expect(more).toHaveLength(0)
    expect(only).toMatchObject({ kind: 'image', label: 'logo' })
  })

  it('keep a name with markup in it literal', async () => {
    const [created] = await uploadImageFrames('c1', [image('"a" <b>.png', 100, 100)])
    const doc = new DOMParser().parseFromString(created?.html ?? '', 'text/html')
    const img = doc.querySelector('img')
    expect(img?.getAttribute('data-name')).toBe('"a" <b>')
    expect(img?.getAttribute('alt')).toBe('"a" <b>')
    expect(doc.querySelector('b')).toBeNull()
  })
})
