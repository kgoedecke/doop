// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { componentScript } from '../shared/designSystem.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const execute = (code: string) => new Function(code)() as void

/* counts how often each instance was handed to the script */
const SCRIPT = 'elements.forEach(function (el) { el.dataset.runs = String(Number(el.dataset.runs || 0) + 1) })'

it('sets up instances added after the script ran, once each, and never twice for a rerun', async () => {
  delete (window as { __doopComponents?: unknown }).__doopComponents
  document.body.innerHTML = '<button data-doop-component="toggle">A</button>'
  execute(componentScript('toggle', SCRIPT))
  const first = document.querySelector<HTMLElement>('[data-doop-component="toggle"]')!
  expect(first.dataset.runs).toBe('1')

  /* an insert morphed into the live frame: the script block does not run again */
  document.body.insertAdjacentHTML('beforeend', '<button data-doop-component="toggle">B</button>')
  await tick()
  const [, second] = document.querySelectorAll<HTMLElement>('[data-doop-component="toggle"]')
  expect(second!.dataset.runs).toBe('1')
  expect(first.dataset.runs).toBe('1')

  /* the same script executed again in this document does nothing */
  execute(componentScript('toggle', SCRIPT))
  await tick()
  expect(first.dataset.runs).toBe('1')
  expect(second!.dataset.runs).toBe('1')
})
