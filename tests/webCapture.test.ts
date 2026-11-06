// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/api', () => ({ api: { createFrame: vi.fn() } }))
vi.mock('../src/lib/store', () => ({ useStore: { getState: vi.fn() } }))
vi.mock('../src/lib/history', () => ({ recordCreate: vi.fn() }))
vi.mock('../src/lib/framePlacement', () => ({ frameCenterPosition: vi.fn(), stageViewportSize: vi.fn() }))
import { api } from '../src/lib/api'
import { useStore } from '../src/lib/store'
import { recordCreate } from '../src/lib/history'
import { frameCenterPosition, stageViewportSize } from '../src/lib/framePlacement'
import { CAPTURE_PREFIX, parseWebCapture, pasteWebCapture } from '../src/lib/webCapture'
const payload = (html: string, width = 800) =>
  CAPTURE_PREFIX + JSON.stringify({ name: 'Example', html, width, height: 600 })
describe('Doop capture clipboard', () => {
  it('preserves editable styled content and dimensions', () => {
    const capture = parseWebCapture(payload('<main style="color:red"><h1>Hello</h1></main>'))
    expect(capture.width).toBe(800)
    expect(capture.html).toContain('<h1>Hello</h1>')
    expect(capture.html).toContain('color:red')
  })
  it('removes active content and inserts restrictive CSP', () => {
    const capture = parseWebCapture(
      payload(
        '<script>alert(1)</script><iframe srcdoc="bad"></iframe><a href="javascript:alert(1)" onclick="bad()">Link</a><form action="https://example.com"><input autofocus></form>',
      ),
    )
    expect(capture.html).not.toContain('<script')
    expect(capture.html).not.toContain('<iframe')
    expect(capture.html).not.toContain('onclick')
    expect(capture.html).not.toContain('javascript:')
    expect(capture.html).not.toContain('action=')
    expect(capture.html).toContain("script-src 'none'")
  })
  it('rejects malformed, oversized and invalid dimensions', () => {
    expect(() => parseWebCapture('ordinary text')).toThrow()
    expect(() => parseWebCapture(payload('<p>x</p>', -1))).toThrow()
    expect(() => parseWebCapture(payload('x'.repeat(3_000_001)))).toThrow()
  })
})

describe('capture import', () => {
  it('creates on the active page, centers, records undo and selects the new frame', async () => {
    const selectMany = vi.fn()
    vi.mocked(useStore.getState).mockReturnValue({
      activePageId: 'page-2',
      viewport: { x: 0, y: 0, zoom: 1 },
      selectMany,
    } as unknown as ReturnType<typeof useStore.getState>)
    vi.mocked(stageViewportSize).mockReturnValue({ width: 1200, height: 900 })
    vi.mocked(frameCenterPosition).mockReturnValue({ x: 200, y: 150 })
    const frame = { id: 'imported-frame' } as Awaited<ReturnType<typeof api.createFrame>>
    vi.mocked(api.createFrame).mockResolvedValue(frame)
    await pasteWebCapture('canvas-1', payload('<h1>Captured page</h1>'))
    expect(api.createFrame).toHaveBeenCalledWith(
      'canvas-1',
      expect.objectContaining({ pageId: 'page-2', x: 200, y: 150, width: 800, height: 600 }),
    )
    expect(recordCreate).toHaveBeenCalledWith(frame)
    expect(selectMany).toHaveBeenCalledWith(['imported-frame'])
  })
  it('rejects malformed content before sending an API request', async () => {
    vi.mocked(api.createFrame).mockClear()
    await expect(pasteWebCapture('canvas-1', payload('<p>Bad size</p>', 0))).rejects.toThrow()
    expect(api.createFrame).not.toHaveBeenCalled()
  })
})
