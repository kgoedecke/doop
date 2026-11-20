// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ canvasSkills: vi.fn(), listSkills: vi.fn(), navigate: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { canvasSkills: mocks.canvasSkills, listSkills: mocks.listSkills } }))
vi.mock('../src/lib/navigate', () => ({ navigate: mocks.navigate }))
import { useSkillMenu, type SkillSource } from '../src/components/SkillMenu'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* a field shaped like the composer's: Enter sends unless the menu takes it */
let sent: string[]
function Field({ from = { canvasId: 'c1' }, offerNew = false }: { from?: SkillSource; offerNew?: boolean }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const skill = useSkillMenu({ from, text, setText, inputRef: ref, offerNew })
  return (
    <div className="relative">
      {skill.menu}
      <button type="button" data-testid="skills" onClick={skill.openMenu} />
      <textarea
        ref={ref}
        value={text}
        {...skill.inputProps}
        onKeyDown={(e) => {
          if (skill.onKeyDown(e)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            sent.push(text)
          }
        }}
      />
    </div>
  )
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  sent = []
  mocks.navigate.mockReset()
  mocks.canvasSkills.mockResolvedValue({
    skills: [
      { handle: 'brand-check', description: 'Brand voice' },
      { handle: 'release-notes', description: 'Release notes tone' },
    ],
    addIn: { workspaceId: 'ws1' },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const field = () => host.querySelector('textarea')!
const options = () => [...host.querySelectorAll('[role=option]')].map((o) => o.textContent)

async function type(value: string) {
  const el = field()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.setSelectionRange(value.length, value.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

it('lists the canvas’s skills on "/", narrows them, and Enter writes the handle instead of sending', async () => {
  act(() => root.render(<Field />))
  await type('tighten it /')
  expect(options()).toEqual(['/brand-checkBrand voice', '/release-notesRelease notes tone'])
  expect(field().getAttribute('aria-expanded')).toBe('true')

  await type('tighten it /br')
  expect(options()).toEqual(['/brand-checkBrand voice'])
  await press('Enter')
  expect(field().value).toBe('tighten it /brand-check ')
  expect(sent).toEqual([])
  expect(options()).toEqual([])

  /* with the menu closed, Enter is the field's again */
  await press('Enter')
  expect(sent).toEqual(['tighten it /brand-check '])
  expect(mocks.canvasSkills).toHaveBeenCalledWith('c1')
})

it('moves with the arrows, closes on Esc, and lets Enter send when nothing matches', async () => {
  act(() => root.render(<Field />))
  await type('/')
  await press('ArrowDown')
  expect(host.querySelector('[aria-selected=true]')?.textContent).toContain('/release-notes')
  await press('Escape')
  expect(options()).toEqual([])

  await type('see /c/abc')
  await press('Enter')
  expect(sent).toEqual(['see /c/abc'])
})

it('says where skills come from on a canvas that has none', async () => {
  mocks.canvasSkills.mockResolvedValue({ skills: [], addIn: null })
  act(() => root.render(<Field />))
  await type('/')
  expect(host.textContent).toContain('No skills here yet')
  await press('Enter')
  expect(sent).toEqual(['/'])
})

it('opens from the Skills button at the caret and ends with a way to add one', async () => {
  act(() => root.render(<Field offerNew />))
  await type('tighten it')
  await act(async () => (host.querySelector('[data-testid=skills]') as HTMLButtonElement).click())
  expect(field().value).toBe('tighten it /')
  expect(options()).toEqual(['/brand-checkBrand voice', '/release-notesRelease notes tone', 'New skill'])

  /* the arrows reach it too, and it goes to the form of the canvas's scope */
  await press('ArrowUp')
  await press('Enter')
  expect(mocks.navigate).toHaveBeenCalledWith('/w/ws1?pane=agents&skill=new')
})

it('offers to add the first skill, in the person’s own settings on a personal canvas', async () => {
  mocks.canvasSkills.mockResolvedValue({ skills: [], addIn: { personal: true } })
  act(() => root.render(<Field offerNew />))
  await type('/')
  expect(options()).toEqual(['New skill'])
  /* Enter takes the only row instead of sending a bare "/" */
  await press('Enter')
  expect(sent).toEqual([])
  expect(mocks.navigate).toHaveBeenCalledWith('/settings?pane=agent&skill=new')
})

it('offers no way to add where the person may not, or where the field does not ask', async () => {
  mocks.canvasSkills.mockResolvedValue({ skills: [{ handle: 'brand-check', description: 'Brand voice' }], addIn: null })
  act(() => root.render(<Field offerNew />))
  await type('/')
  expect(options()).toEqual(['/brand-checkBrand voice'])

  mocks.canvasSkills.mockResolvedValue({ skills: [], addIn: { workspaceId: 'ws1' } })
  act(() => root.render(<Field from={{ canvasId: 'c2' }} />))
  await type('x /')
  expect(options()).toEqual([])
  expect(host.textContent).toContain('No skills here yet')
})

it('lists the picked scope’s skills before the canvas exists (Home)', async () => {
  mocks.listSkills.mockResolvedValue([
    { handle: 'ws-tone', description: 'Workspace tone', body: 'x'.repeat(20), createdAt: 1, updatedAt: 1 },
  ])
  act(() => root.render(<Field from={{ scope: { workspaceId: 'ws1' } }} />))
  await type('a landing page /')
  expect(options()).toEqual(['/ws-toneWorkspace tone'])
  expect(mocks.listSkills).toHaveBeenCalledWith('ws1')
  expect(mocks.canvasSkills).not.toHaveBeenCalled()

  /* picking another scope reads that scope's list */
  mocks.listSkills.mockResolvedValue([])
  act(() => root.render(<Field from={{ scope: { personal: true } }} />))
  await type('a landing page /x /')
  expect(mocks.listSkills).toHaveBeenLastCalledWith(undefined)
  expect(host.textContent).toContain('No skills here yet')
})

it('shows nothing where the list is refused, and drops an answer for a canvas it left', async () => {
  mocks.canvasSkills.mockRejectedValue(new Error('403'))
  act(() => root.render(<Field />))
  await type('/')
  expect(host.querySelector('[data-pan-stop]')).toBeNull()

  /* an automation step switches canvas while the first answer is still out */
  await type('')
  let answerFirst: (value: unknown) => void = () => {}
  mocks.canvasSkills.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
  mocks.canvasSkills.mockResolvedValueOnce({ skills: [{ handle: 'second', description: 'B' }], addIn: null })
  act(() => root.render(<Field from={{ canvasId: 'c-a' }} />))
  await type('x /')
  /* the switch reads the new canvas's list by itself */
  await act(async () => root.render(<Field from={{ canvasId: 'c-b' }} />))
  await act(async () => answerFirst({ skills: [{ handle: 'first', description: 'A' }], addIn: null }))
  expect(options()).toEqual(['/secondB'])
})

it('closes only the current menu on Esc: a "/" typed again opens it', async () => {
  act(() => root.render(<Field />))
  await type('/')
  await press('Escape')
  expect(options()).toEqual([])
  await type('')
  await type('/')
  expect(options()).toEqual(['/brand-checkBrand voice', '/release-notesRelease notes tone'])
})

it('reads the list again for every new "/", even at the same spot', async () => {
  act(() => root.render(<Field />))
  await type('/')
  expect(options()).toHaveLength(2)
  mocks.canvasSkills.mockResolvedValue({ skills: [{ handle: 'added', description: 'New one' }], addIn: null })
  await type('')
  await type('/')
  expect(options()).toEqual(['/addedNew one'])
})

it('stops offering a canvas’s skills once the field moves to another canvas', async () => {
  act(() => root.render(<Field from={{ canvasId: 'c-a' }} />))
  await type('x /')
  expect(options()).toHaveLength(2)
  let answer: (value: unknown) => void = () => {}
  mocks.canvasSkills.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
  await act(async () => root.render(<Field from={{ canvasId: 'c-b' }} />))
  expect(options()).toEqual([])
  await act(async () => answer({ skills: [{ handle: 'b-only', description: 'B' }], addIn: null }))
  expect(options()).toEqual(['/b-onlyB'])
})

it('scrolls the row the arrows pick into view', async () => {
  const scrolled: string[] = []
  const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    scrolled.push(this.textContent ?? '')
  })
  act(() => root.render(<Field />))
  await type('/')
  await press('ArrowDown')
  expect(scrolled.at(-1)).toContain('/release-notes')
  spy.mockRestore()
})

it('replaces the whole handle when picking with the caret inside it', async () => {
  act(() => root.render(<Field />))
  await type('/brand-check then more')
  const el = field()
  await act(async () => {
    el.focus()
    el.setSelectionRange(3, 3)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await act(async () => {})
  expect(options()).toEqual(['/brand-checkBrand voice'])
  await press('Enter')
  expect(el.value).toBe('/brand-check then more')
})

it('keeps the word after the caret when the Skills button opens the menu before it', async () => {
  act(() => root.render(<Field />))
  await type('hello world')
  const el = field()
  await act(async () => {
    el.focus()
    el.setSelectionRange(6, 6)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await act(async () => (host.querySelector('[data-testid=skills]') as HTMLButtonElement).click())
  await act(async () => {})
  await press('Enter')
  expect(el.value).toBe('hello /brand-check world')
})
