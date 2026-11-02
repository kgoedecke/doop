// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal, ModalTitle } from '../src/components/ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../src/components/ui/select'
import { Switch } from '../src/components/ui/switch'

/**
 * The two form primitives that replaced AutomateShell's hand-rolled Toggle
 * and native Sel: each renders the role assistive tech expects, takes its
 * size, and reports the new value through its change callback.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(node: React.ReactNode) {
  act(() => root.render(node))
}

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  /* Radix Select scrolls the chosen item into view when the list opens */
  Element.prototype.scrollIntoView ??= () => {}
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Switch', () => {
  it('renders a switch that reports the flipped value', () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Weekly pull" />)
    const el = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(el.getAttribute('aria-checked')).toBe('false')
    expect(el.getAttribute('aria-label')).toBe('Weekly pull')
    expect(el.dataset.size).toBe('md')
    act(() => el.click())
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('takes the small size and stays put when disabled', () => {
    const onCheckedChange = vi.fn()
    render(<Switch size="sm" checked disabled onCheckedChange={onCheckedChange} aria-label="Off limits" />)
    const el = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(el.dataset.size).toBe('sm')
    expect(el.getAttribute('aria-checked')).toBe('true')
    act(() => el.click())
    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})

function RolePicker({ onChange, initial = 'member' }: { onChange: (v: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    >
      <SelectTrigger size="sm" aria-label="Role">
        <SelectValue placeholder="Pick a role" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">Member</SelectItem>
        <SelectItem value="admin">Admin</SelectItem>
      </SelectContent>
    </Select>
  )
}

describe('Select', () => {
  it('shows the chosen item on a sized combobox trigger', () => {
    render(<RolePicker onChange={() => {}} />)
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expect(trigger.getAttribute('aria-label')).toBe('Role')
    expect(trigger.dataset.size).toBe('sm')
    expect(trigger.textContent).toContain('Member')
  })

  it('shows the placeholder for the empty value', () => {
    render(<RolePicker onChange={() => {}} initial="" />)
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expect(trigger.textContent).toContain('Pick a role')
    expect(trigger.hasAttribute('data-placeholder')).toBe(true)
  })

  it('opens from the keyboard and reports the picked value', () => {
    const onChange = vi.fn()
    render(<RolePicker onChange={onChange} />)
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    act(() => trigger.focus())
    key(trigger, 'ArrowDown')
    const admin = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent === 'Admin')
    expect(admin).toBeDefined()
    key(admin!, 'Enter')
    expect(onChange).toHaveBeenCalledWith('admin')
    expect(trigger.textContent).toContain('Admin')
  })
})

describe('Select inside a Modal', () => {
  /* the workspace pickers live in modals: the list must stack on the dialog's
     dismiss and focus layers, so Escape closes the list, not the modal */
  it('picks a value, and Escape closes only the list and refocuses the trigger', () => {
    const onChange = vi.fn()
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose}>
        <ModalTitle>Move canvas</ModalTitle>
        <RolePicker onChange={onChange} />
      </Modal>,
    )
    const trigger = () => document.querySelector<HTMLButtonElement>('[role="combobox"]')!
    act(() => trigger().focus())
    key(trigger(), 'ArrowDown')
    const admin = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent === 'Admin')
    key(admin!, 'Enter')
    expect(onChange).toHaveBeenCalledWith('admin')
    expect(onClose).not.toHaveBeenCalled()

    key(trigger(), 'ArrowDown')
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    key(document.activeElement ?? document.body, 'Escape')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger())
  })
})
