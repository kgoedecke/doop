// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Avatar, AvatarStack } from '../src/components/ui/avatar'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

it('shows the photo in place of the initials, and the initials when it fails', async () => {
  await act(async () => root.render(<Avatar name="Alice Avatar" image="/a/one.png" color="#f00" />))
  const img = container.querySelector('img')!
  expect(img.getAttribute('src')).toBe('/a/one.png')
  expect(container.textContent).toBe('')
  /* the tint is for letters; a photo fills the disc */
  expect(container.querySelector<HTMLElement>('[data-slot="avatar"]')!.style.background).toBe('')

  await act(async () => img.dispatchEvent(new Event('error')))
  expect(container.querySelector('img')).toBeNull()
  expect(container.textContent).toBe('AA')

  /* a different photo gets its own try */
  await act(async () => root.render(<Avatar name="Alice Avatar" image="/a/two.png" color="#f00" />))
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/a/two.png')
})

it('keeps initials for agents, overflow discs and people without a photo', async () => {
  await act(async () =>
    root.render(
      <>
        <Avatar name="Claude Code" kind="agent" image="/a/x.png" />
        <AvatarStack
          max={1}
          people={[
            { id: '1', name: 'Bob Avatar' },
            { id: '2', name: 'Cy Avatar', image: '/a/cy.png' },
          ]}
        />
      </>,
    ),
  )
  expect(container.querySelectorAll('img')).toHaveLength(0)
  expect(container.textContent).toContain('BA')
  expect(container.textContent).toContain('+1')
})
