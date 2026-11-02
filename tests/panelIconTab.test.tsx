// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelIconTab, PanelTabPanel, PanelTabs, PanelTabsRoot } from '../src/components/ui/panel'

/**
 * The side panel's tab strip, icon-strip style: every tab is an icon, and only
 * the active one unfolds its label beside the icon. The folded label stays in
 * the DOM so the tab keeps its name for assistive tech and tests alike.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function Strip({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <PanelTabsRoot value={value} onValueChange={onChange}>
      <PanelTabs>
        <PanelIconTab value="tasks" icon={<svg data-testid="spark" />}>
          Agents
        </PanelIconTab>
        <PanelIconTab value="comments" icon={<svg />} badge={<span data-testid="badge">3</span>}>
          Comments
        </PanelIconTab>
      </PanelTabs>
      <PanelTabPanel value="tasks">agents here</PanelTabPanel>
      <PanelTabPanel value="comments">comments here</PanelTabPanel>
    </PanelTabsRoot>
  )
}

function render(value: string, onChange: (next: string) => void = () => {}) {
  act(() => root.render(<Strip value={value} onChange={onChange} />))
}

const tab = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent?.includes(name))!

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PanelIconTab', () => {
  it('shows the icon on every tab and keeps the label in the DOM for the inactive ones', () => {
    render('tasks')
    expect(tab('Agents').dataset.state).toBe('active')
    expect(tab('Comments').dataset.state).toBe('inactive')
    expect(tab('Agents').querySelector('[data-testid="spark"]')).not.toBeNull()
    /* the inactive label is folded, not removed: the tab is still "Comments" */
    expect(tab('Comments').textContent).toContain('Comments')
  })

  it('folds the label through a grid track the active state opens', () => {
    render('tasks')
    const label = (name: string) => tab(name).querySelector('.grid-cols-\\[0fr\\]')!
    expect(label('Agents').className).toContain('group-data-[state=active]:grid-cols-[1fr]')
    expect(label('Comments').className).toContain('group-data-[state=active]:grid-cols-[1fr]')
  })

  it('pins the badge to the tab, outside the folding label', () => {
    render('tasks')
    const badge = tab('Comments').querySelector('[data-testid="badge"]')!
    expect(badge.closest('.overflow-hidden')).toBeNull()
  })

  it('switches tabs on click', () => {
    let current = 'tasks'
    render('tasks', (next) => {
      current = next
      render(next, () => {})
    })
    act(() => tab('Comments').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(current).toBe('comments')
    expect(container.textContent).toContain('comments here')
    expect(container.textContent).not.toContain('agents here')
  })
})
