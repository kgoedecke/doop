// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const accountState = vi.hoisted(() => ({
  account: { connected: true, kind: 'custom-key' as const, model: 'm-missing', menus: { 'custom-key': [] } },
}))

vi.mock('../src/components/ModelAccount', () => ({
  useModelAccount: () => ({ account: accountState.account, set: vi.fn(), refresh: vi.fn() }),
  useAgentModels: () => ({ models: [{ id: 'm-a', name: 'm-a', blurb: '' }], live: true }),
}))

vi.mock('../src/lib/api', () => ({ api: { setAgentModel: vi.fn().mockResolvedValue(accountState.account) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/i18n', () => ({ useT: () => (key: string) => key, t: (key: string) => key }))
vi.mock('../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuCaption: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode
    onValueChange: (value: string) => void
  }) =>
    Array.isArray(children) ? (
      <div>
        {children.map((child: { props: { value: string; children: React.ReactNode } }, index: number) => (
          <button key={index} onClick={() => onValueChange(child.props.value)}>
            {child.props.children}
          </button>
        ))}
      </div>
    ) : (
      <div>{children}</div>
    ),
  DropdownMenuRadioItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <span data-value={value}>{children}</span>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { ModelPicker } from '../src/components/ModelPicker'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the live list and keeps the saved missing model visible', async () => {
  await act(async () => root.render(<ModelPicker />))
  expect(container.textContent).toContain('m-a')
  expect(container.textContent).toContain('m-missing')
  expect(container.textContent).toContain('models.customModelMissing')
})

it('calls setAgentModel when a live model is selected', async () => {
  const { api } = await import('../src/lib/api')
  await act(async () => root.render(<ModelPicker />))
  const item = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('m-a'))
  await act(async () => item?.click())
  expect(api.setAgentModel).toHaveBeenCalledWith('m-a')
})
