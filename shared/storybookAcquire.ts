import type { StorybookComponent } from './storybookIndex.ts'
import { storyUrl } from './storybookIndex.ts'
import type { StoryAnswer, StoryArgType, StoryCapture, StoryCommand } from './storybookCapture.ts'

/**
 * Rendering one Storybook component every way an import needs it: its base story, each value of
 * each prop it can turn into a Doop variant, and dark. Browser-agnostic: the server drives it with
 * its renderer's pages, the CLI with Playwright. Spec: .context/specs/storybook-import.md.
 */

/** One browser tab on a Storybook, as the import uses it. */
export interface StoryTab {
  open(url: string): Promise<void>
  run(command: StoryCommand): Promise<StoryAnswer>
  /** the captured root as a PNG, where the driver can take one (the fidelity check) */
  screenshot?(): Promise<Buffer | undefined>
  /** switch `prefers-color-scheme` */
  colorScheme?(dark: boolean): Promise<void>
}

/** A prop of the Doop component, and the Storybook arg it comes from. */
export interface CapturedProp {
  /** the Doop prop name: lowercase, hyphens */
  name: string
  arg: string
  kind: 'enum' | 'boolean'
  /** as Doop shows them */
  options: string[]
  /** as Storybook takes them, in the same order */
  values: (string | number | boolean)[]
  default: string
  description?: string
}

export interface ComponentCapture {
  title: string
  name: string
  storyId: string
  codePath?: string
  description?: string
  props: CapturedProp[]
  /** string args shown as text: bound to the element that shows them */
  texts: { name: string; arg: string; value: string; description?: string }[]
  base: StoryCapture
  variants: { prop: string; value: string; capture?: StoryCapture; error?: string }[]
  /** custom properties whose value differs in dark */
  darkVars?: Record<string, string>
  /** base64 PNG of the base render, for the fidelity check */
  screenshot?: string
  warnings: string[]
}

export const MAX_VARIANT_RENDERS = 24
const RESERVED_PROPS = new Set(['component', 'id', 'class', 'style', 'overrides', 'slot'])

/** `buttonText` → `button-text`, kept clear of what `<doop-use>` keeps for itself. */
export function propName(arg: string, taken: Set<string>): string | null {
  let name = arg
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  if (!name || !/^[a-z]/.test(name)) return null
  if (RESERVED_PROPS.has(name) || name.startsWith('data-doop')) name = `${name}-prop`
  while (taken.has(name)) name = `${name}-2`
  taken.add(name)
  return name
}

function propsOf(argTypes: StoryArgType[]) {
  const taken = new Set<string>()
  const props: CapturedProp[] = []
  const texts: ComponentCapture['texts'] = []
  for (const arg of argTypes) {
    if (arg.kind === 'text') {
      const name = propName(arg.name, taken)
      if (name && typeof arg.initial === 'string')
        texts.push({
          name,
          arg: arg.name,
          value: arg.initial,
          ...(arg.description ? { description: arg.description } : {}),
        })
      continue
    }
    const values: (string | number | boolean)[] = arg.kind === 'boolean' ? [false, true] : [...arg.options!]
    if (values.length > 12) continue
    const name = propName(arg.name, taken)
    if (!name) continue
    const initial = arg.initial ?? (arg.kind === 'boolean' ? false : values[0])
    const at = Math.max(
      0,
      values.findIndex((value) => value === initial),
    )
    props.push({
      name,
      arg: arg.name,
      kind: arg.kind,
      options: values.map(String),
      values,
      default: String(values[at]),
      ...(arg.description ? { description: arg.description } : {}),
    })
  }
  return { props, texts }
}

async function ask<K extends StoryAnswer['kind']>(
  tab: StoryTab,
  command: StoryCommand,
  kind: K,
): Promise<Extract<StoryAnswer, { kind: K }>> {
  const answer = await tab.run(command)
  if (answer.kind === 'error') throw new Error(answer.error)
  if (answer.kind !== kind) throw new Error(`the story page answered ${answer.kind}, not ${kind}`)
  return answer as Extract<StoryAnswer, { kind: K }>
}

export interface AcquireOptions {
  /** the CLI: carry files only this machine reaches as data: URIs */
  inline?: boolean
  /** a story other than the component's base */
  storyId?: string
  /** a CSS selector for the part of the story that is the component */
  select?: string
  /** told as each render lands */
  onStep?: (what: string) => void
}

export async function acquireComponent(
  tab: StoryTab,
  base: URL,
  component: StorybookComponent,
  options: AcquireOptions = {},
): Promise<ComponentCapture> {
  let storyId = options.storyId ?? component.baseStoryId
  const inline = options.inline ?? false
  const select = options.select
  await tab.colorScheme?.(false)
  await tab.open(storyUrl(base, storyId))
  let { meta } = await ask(tab, { kind: 'meta' }, 'meta')
  /* a Default story without controls: its Playground is the one written to have them */
  const playground = component.stories.find((story) => /playground/i.test(story.name) && story.id !== storyId)
  if (!options.storyId && playground && !propsOf(meta.argTypes).props.length) {
    await tab.open(storyUrl(base, playground.id))
    const other = (await ask(tab, { kind: 'meta' }, 'meta')).meta
    if (!other.error && propsOf(other.argTypes).props.length) {
      storyId = playground.id
      meta = other
    } else await tab.open(storyUrl(base, storyId))
  }
  if (meta.error) throw new Error(`Storybook could not render ${storyId}: ${meta.error}`)
  const { props, texts } = propsOf(meta.argTypes)
  const warnings: string[] = []
  const { capture: baseCapture } = await ask(tab, { kind: 'capture', inline, ...(select ? { select } : {}) }, 'capture')
  warnings.push(...baseCapture.warnings)
  const screenshot = await tab.screenshot?.()

  const variants: ComponentCapture['variants'] = []
  const kept: CapturedProp[] = []
  let renders = 0
  for (const prop of props) {
    const others = prop.values.filter((value) => String(value) !== prop.default)
    if (renders + others.length > MAX_VARIANT_RENDERS) {
      warnings.push(`prop “${prop.arg}” was left out: past ${MAX_VARIANT_RENDERS} variant renders`)
      continue
    }
    kept.push(prop)
    for (const value of others) {
      renders++
      options.onStep?.(`${component.name}: ${prop.arg}=${String(value)}`)
      const rendered = await ask(tab, { kind: 'args', args: { [prop.arg]: value } }, 'rendered')
      if (rendered.error) {
        variants.push({ prop: prop.name, value: String(value), error: rendered.error })
      } else {
        const { capture } = await ask(tab, { kind: 'capture', inline, ...(select ? { select } : {}) }, 'capture')
        variants.push({ prop: prop.name, value: String(value), capture })
      }
      const reset = await ask(tab, { kind: 'args', args: {}, reset: true }, 'rendered')
      if (reset.error) throw new Error(`could not restore the story defaults: ${reset.error}`)
    }
  }

  /* dark last: what differs in it is all the import needs */
  let darkVars: Record<string, string> | undefined
  const names = Object.keys(baseCapture.vars)
  if (names.length) {
    if (meta.dark && 'globals' in meta.dark) await ask(tab, { kind: 'globals', globals: meta.dark.globals }, 'rendered')
    await tab.colorScheme?.(true)
    const { vars } = await ask(tab, { kind: 'vars', names }, 'vars')
    const differ = Object.entries(vars).filter(([name, value]) => value && value !== baseCapture.vars[name])
    if (differ.length) darkVars = Object.fromEntries(differ)
    await tab.colorScheme?.(false)
  }

  return {
    title: component.title,
    name: component.name,
    storyId,
    ...(component.codePath ? { codePath: component.codePath } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    props: kept,
    texts,
    base: baseCapture,
    variants,
    ...(darkVars ? { darkVars } : {}),
    ...(screenshot ? { screenshot: screenshot.toString('base64') } : {}),
    warnings,
  }
}
