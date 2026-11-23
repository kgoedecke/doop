// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImageModelStatus } from '../src/lib/api'
const OWN = 'custom:aaaaaaaa11111111'
const SHARED = 'custom:bbbbbbbb22222222'
const mocks = vi.hoisted(() => ({
  imageModels: vi.fn(),
  setImageModel: vi.fn(),
  capture: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: { imageModels: mocks.imageModels, setImageModel: mocks.setImageModel },
}))
vi.mock('../src/lib/store', () => ({
  useStore: (select: (state: { allowanceVersion: number }) => unknown) => select({ allowanceVersion: 0 }),
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
import { ImageModelCard } from '../src/components/ImageModelCard'
import { IMAGE_MODELS } from '../shared/modelMenu'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The image-model list: after the registry come the image models of the
   person's custom providers, one row per provider (a shared one named so),
   pickable like any other row. */

const registry = (selected = ''): ImageModelStatus[] =>
  IMAGE_MODELS.map((option) => ({ id: option.id, available: false, selected: option.id === selected }))

const models = (selected: string): ImageModelStatus[] => [
  ...registry(),
  {
    id: `${OWN}/flux-dev`,
    available: true,
    selected: selected === `${OWN}/flux-dev`,
    custom: { provider: 'Studio FLUX', name: 'FLUX dev', transparent: true },
  },
  {
    id: `${OWN}/sdxl`,
    available: true,
    selected: selected === `${OWN}/sdxl`,
    custom: { provider: 'Studio FLUX', name: 'sdxl' },
  },
  {
    id: `${SHARED}/flux-schnell`,
    available: true,
    selected: selected === `${SHARED}/flux-schnell`,
    custom: { provider: 'Acme Gateway', name: 'flux-schnell', shared: true },
  },
]

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const radios = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
const radio = (name: string) => radios().find((r) => r.textContent?.includes(name))!

async function render() {
  await act(async () => root.render(<ImageModelCard />))
}

it('lists each custom provider’s image models as one row after the registry, the shared one named as shared', async () => {
  mocks.imageModels.mockResolvedValue({ models: models(`${SHARED}/flux-schnell`) })
  await render()
  const names = radios().map((r) => r.querySelector('.font-medium')?.textContent)
  expect(names.slice(-2)).toEqual(['Studio FLUX', 'Acme Gateway (shared)'])
  /* the personal row shows its first model and says it draws cut-outs */
  expect(radio('Studio FLUX').textContent).toContain('FLUX dev, drawn on your custom provider.')
  expect(radio('Studio FLUX').textContent).toContain('Draws transparent backgrounds.')
  expect(radio('Acme Gateway').textContent).toContain('flux-schnell, drawn on the provider your admin shares.')
  /* the chosen one is checked, and only it */
  expect(radio('Acme Gateway').getAttribute('aria-checked')).toBe('true')
  expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  /* a provider with several image models gets the dropdown, one with a single model does not */
  expect(document.querySelector('[aria-label="Model for Studio FLUX"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Model for Acme Gateway (shared)"]')).toBeNull()
})

it('picks a custom provider’s image model by its id', async () => {
  mocks.imageModels.mockResolvedValue({ models: models('') })
  mocks.setImageModel.mockResolvedValue({ models: models(`${OWN}/flux-dev`) })
  await render()
  await act(async () => radio('Studio FLUX').click())
  expect(mocks.setImageModel).toHaveBeenCalledWith(`${OWN}/flux-dev`)
  expect(radio('Studio FLUX').getAttribute('aria-checked')).toBe('true')
  /* analytics learn the kind of pick, never the provider or model id */
  expect(mocks.capture).toHaveBeenCalledWith('image_model_changed', { model: 'custom-personal' })
})

it('keeps a provider’s row, and its focus, when the pick moves to another of its models', async () => {
  mocks.imageModels.mockResolvedValue({ models: models(`${OWN}/flux-dev`) })
  mocks.setImageModel.mockResolvedValue({ models: models(`${OWN}/sdxl`) })
  await render()
  const row = radio('Studio FLUX')
  row.focus()
  await act(async () => row.click())
  /* the server now says sdxl is the pick: the same row shows it */
  expect(mocks.setImageModel).toHaveBeenCalledWith(`${OWN}/flux-dev`)
  expect(radio('Studio FLUX')).toBe(row)
  expect(row.textContent).toContain('sdxl, drawn on your custom provider.')
  expect(document.activeElement).toBe(row)
})

it('shows only the registry when no provider lists image models', async () => {
  mocks.imageModels.mockResolvedValue({ models: registry() })
  await render()
  expect(radios().some((r) => r.textContent?.includes('custom provider'))).toBe(false)
})
