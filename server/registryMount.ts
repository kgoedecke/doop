import { createElement, type ElementType, type ReactNode } from 'react'

/** Choose a runnable demo when one is exported. For primitive-only shadcn
 * items, compose their own exports so providers and initially closed overlays
 * produce a visible design snapshot. No replacement component markup is used. */
export function registryMount(entry: Record<string, unknown>, preferred: string[], label: string) {
  const renderable = (value: unknown) =>
    typeof value === 'function' || (value && typeof value === 'object' && '$$typeof' in value)
  const name = renderable(entry.default)
    ? 'default'
    : (preferred.find((key) => renderable(entry[key])) ??
      Object.keys(entry).find((key) => /^[A-Z]/.test(key) && renderable(entry[key])))
  if (!name) throw new Error('This registry item has no React component export')
  const has = (suffix: string) => renderable(entry[name + suffix])
  const part = (suffix: string, props: Record<string, unknown> = {}, ...children: ReactNode[]): ReactNode =>
    createElement(entry[name + suffix] as ElementType, props, ...children)
  let node: ReactNode
  if (name === 'Accordion' && has('Item') && has('Trigger') && has('Content')) {
    node = part(
      '',
      { type: 'single', defaultValue: 'example', collapsible: true },
      part('Item', { value: 'example' }, part('Trigger', {}, label), part('Content', {}, 'Accordion content')),
    )
  } else if (name === 'Tabs' && has('List') && has('Trigger') && has('Content')) {
    node = part(
      '',
      { defaultValue: 'example' },
      part('List', {}, part('Trigger', { value: 'example' }, 'Preview')),
      part('Content', { value: 'example' }, label),
    )
  } else if (has('Trigger') && has('Content')) {
    const content: ReactNode[] = []
    if (has('Title')) content.push(part('Title', { key: 'title' }, label))
    if (has('Description')) content.push(part('Description', { key: 'description' }, 'Component preview'))
    if (has('Item')) content.push(part('Item', { key: 'item', value: 'example' }, label))
    if (!content.length) content.push(label)
    node = part(
      '',
      { open: true, defaultOpen: true },
      part('Trigger', {}, has('Value') ? part('Value', { placeholder: label }) : label),
      part('Content', {}, ...content),
    )
    if (has('Provider')) node = part('Provider', {}, node)
  } else if (name === 'Card' && has('Header') && has('Title') && has('Content')) {
    node = part(
      '',
      { className: 'w-full max-w-sm' },
      part(
        'Header',
        {},
        part('Title', {}, label),
        has('Description') ? part('Description', {}, 'A card with a header, content, and footer.') : null,
      ),
      part('Content', {}, 'Use this component to group related information and actions.'),
      has('Footer') ? part('Footer', {}, 'Card footer') : null,
    )
  } else {
    node = part('', {}, label)
  }
  return { node, name }
}
