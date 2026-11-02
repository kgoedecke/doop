// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { LibraryComponent } from '../shared/designSystem'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', async (actual) => ({
  ...(await actual<typeof import('../src/lib/api')>()),
  api: { createFrame: vi.fn(), updateFrame: vi.fn() },
}))
const { api, ApiError } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { clearHistory } = await import('../src/lib/history')
const { insertComponent } = await import('../src/lib/library')

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'first',
  name: 'Listagem',
  html: '<!doctype html><html><head></head><body><h1>Bancos</h1></body></html>',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  createdAt: 0,
  updatedAt: 41,
  updatedBy: 'Me',
}
const button = {
  id: 'cmp_1',
  slug: 'botao',
  name: 'Botão',
  groupId: 'buttons',
  description: '',
  html: '<button data-doop-component="botao">OK</button>',
  css: '',
  js: '',
  variants: [],
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Me',
} satisfies LibraryComponent

beforeEach(() => {
  vi.resetAllMocks()
  clearHistory()
  useStore
    .getState()
    .setCanvas({ id: 'c', name: 'Test', frames: [frame], pages: [{ id: 'first', name: 'Main' }] } as Canvas)
  useStore.getState().setActivePage('first')
  useStore.getState().select('f')
  useStore.setState({ notice: null })
})

it('saves an insert against the version it was made from', async () => {
  vi.mocked(api.updateFrame).mockImplementation(async (_id, patch) => ({ ...frame, ...patch, updatedAt: 42 }))
  await insertComponent('c', button, '')
  expect(api.updateFrame).toHaveBeenCalledWith(
    'f',
    expect.objectContaining({ html: expect.stringContaining('botao') }),
    41,
  )
  expect(useStore.getState().canvas!.frames[0]!.html).toContain('data-doop-component="botao"')
})

it('keeps newer work when the frame changed meanwhile, and says so', async () => {
  const newer = { ...frame, html: frame.html.replace('Bancos', 'Bancos (editado)'), updatedAt: 50, updatedBy: 'Agent' }
  vi.mocked(api.updateFrame).mockRejectedValue(new ApiError(409, JSON.stringify({ error: 'conflict', frame: newer })))
  await insertComponent('c', button, '')
  const shown = useStore.getState().canvas!.frames[0]!
  expect(shown.html).toContain('Bancos (editado)')
  expect(shown.html).not.toContain('botao')
  expect(useStore.getState().notice).toBeTruthy()
})
