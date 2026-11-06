// @vitest-environment happy-dom
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import script from '../chrome-extension/capture.js?raw'
vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/store', () => ({ useStore: {} }))
vi.mock('../src/lib/history', () => ({ recordCreate: vi.fn() }))
vi.mock('../src/lib/framePlacement', () => ({ frameCenterPosition: vi.fn(), stageViewportSize: vi.fn() }))
import { CAPTURE_PREFIX, parseWebCapture } from '../src/lib/webCapture'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function capture(markup: string, width = 1200, height = 900) {
  document.body.innerHTML = markup
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(height)
  let toolbar: ShadowRoot
  const attachShadow = Element.prototype.attachShadow
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, options) {
    toolbar = attachShadow.call(this, options)
    return toolbar
  })
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  const captureWindow: { __doopCapture?: (mode: string) => void; __doopCaptureCleanup?: () => void } = {}
  const properties = ['color', '-webkit-user-modify', 'user-select']
  const values: Record<string, string> = {
    color: 'rgb(255, 0, 0)',
    '-webkit-user-modify': 'read-only',
    'user-select': 'none',
  }
  runInNewContext(script, {
    window: captureWindow,
    document,
    navigator: { clipboard: { writeText } },
    Node,
    Element,
    HTMLImageElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    TextEncoder,
    getComputedStyle: () =>
      Object.assign([...properties], {
        display: 'block',
        position: 'static',
        getPropertyValue: (property: string) => values[property],
      }),
  })
  captureWindow.__doopCapture!('page')
  const status = toolbar!.querySelector('span')!
  const button = status.querySelector('button')
  button?.click()
  captureWindow.__doopCaptureCleanup!()
  return { status: status.textContent, writeText }
}

describe('Chrome capture script', () => {
  it('omits editing restrictions while retaining visual styles through import', () => {
    const { writeText } = capture('<p>Hello</p>')
    const result = parseWebCapture(writeText.mock.calls[0]![0])
    const doc = new DOMParser().parseFromString(result.html, 'text/html')
    const paragraph = doc.querySelector('p')!
    paragraph.contentEditable = 'true'
    expect(paragraph.style.color).toBe('rgb(255, 0, 0)')
    expect(paragraph.style.getPropertyValue('-webkit-user-modify')).toBe('')
    expect(paragraph.style.getPropertyValue('user-select')).toBe('')
  })

  it('preserves control types without exporting form values or checked state', () => {
    const { writeText } = capture(
      '<input type="checkbox" checked value="secret"><input type="radio" checked><input type="password" value="secret"><textarea>private text</textarea>',
    )
    const result = parseWebCapture(writeText.mock.calls[0]![0])
    const doc = new DOMParser().parseFromString(result.html, 'text/html')
    expect([...doc.querySelectorAll('input')].map((input) => input.type)).toEqual(['checkbox', 'radio', 'password'])
    expect(doc.querySelector('[checked], [value]')).toBeNull()
    expect(result.html).not.toContain('secret')
    expect(result.html).not.toContain('private text')
  })

  it.each([
    [30001, 900],
    [1200, 100001],
  ])('rejects dimensions %i × %i before offering copy', (width, height) => {
    const { status, writeText } = capture('<p>Hello</p>', width, height)
    expect(status).toContain('Select a smaller section')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('allows the importer’s maximum dimensions', () => {
    const { writeText } = capture('<p>Hello</p>', 30000, 100000)
    const text = writeText.mock.calls[0]![0]
    expect(text.startsWith(CAPTURE_PREFIX)).toBe(true)
    expect(parseWebCapture(text)).toMatchObject({ width: 30000, height: 100000 })
  })
})
