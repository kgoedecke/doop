/**
 * What runs inside a Storybook story's page (`iframe.html?id=…`): reading the story's props from
 * the preview, re-rendering it with other args, and capturing what it drew as markup plus the CSS
 * that can apply to it. Spec: .context/specs/storybook-import.md, "Capturing a story".
 *
 * `storybookPage` is handed to a browser whole (puppeteer's or Playwright's `evaluate`), so it
 * must not reach anything outside itself; the server and the CLI drive it the same way. Before the
 * first call, define `globalThis.__name = (f) => f`: tsx annotates nested functions with it.
 */

/** A prop the import can turn into a Doop prop, as the story's argTypes describe it. */
export interface StoryArgType {
  name: string
  kind: 'enum' | 'boolean' | 'text'
  /** enum: the values as Storybook takes them (strings, numbers) */
  options?: (string | number)[]
  /** the story's own value, when it sets one */
  initial?: string | number | boolean
  description?: string
}

export interface StoryMeta {
  storyId: string
  argTypes: StoryArgType[]
  description?: string
  /** what switches the story to dark, when the Storybook has a way */
  dark?: { globals: Record<string, string> } | { colorScheme: true }
  /** Storybook could not render it */
  error?: string
}

export interface StoryCapture {
  /** the root element as drawn, scaffolding and generated ids out */
  html: string
  /** CSS rule texts that can apply inside it, each wrapped in its at-rules */
  rules: string[]
  /** the custom properties those rules read, resolved on the root */
  vars: Record<string, string>
  /** `@font-face` rules for the families it uses, URLs absolute (or data: from the CLI) */
  fontFaces: string[]
  /** the text style it drew with, as computed on it (font, colour, size, line height) */
  text: Record<string, string>
  width: number
  height: number
  /** things it drew that a component cannot hold: shadow DOM, canvas, a portal */
  warnings: string[]
}

export type StoryCommand =
  | { kind: 'meta' }
  | { kind: 'args'; args: Record<string, string | number | boolean>; reset?: boolean }
  | { kind: 'globals'; globals: Record<string, string> }
  | { kind: 'vars'; names: string[] }
  | { kind: 'capture'; inline: boolean; select?: string }

export type StoryAnswer =
  | { kind: 'meta'; meta: StoryMeta }
  | { kind: 'rendered'; error?: string }
  | { kind: 'vars'; vars: Record<string, string> }
  | { kind: 'capture'; capture: StoryCapture }
  | { kind: 'error'; error: string }

/** The attribute the capture leaves on the live root, for a screenshot of it. */
export const CAPTURE_ROOT_ATTR = 'data-sb-capture-root'

/** Runs in the story's page. */
export async function storybookPage(command: StoryCommand): Promise<StoryAnswer> {
  type Preview = {
    storyStoreValue?: {
      loadStory(input: { storyId: string }): Promise<{
        argTypes: Record<string, Record<string, unknown>>
        initialArgs: Record<string, unknown>
        parameters: Record<string, unknown>
      }>
      projectAnnotations?: { globalTypes?: Record<string, Record<string, unknown>> }
    }
  }
  type Channel = {
    emit(event: string, payload: unknown): void
    on(event: string, listener: (payload: unknown) => void): void
    off(event: string, listener: (payload: unknown) => void): void
  }
  const win = window as unknown as { __STORYBOOK_PREVIEW__?: Preview; __STORYBOOK_ADDONS_CHANNEL__?: Channel }
  const storyId = new URL(location.href).searchParams.get('id') ?? ''
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const storyRoot = () => document.querySelector('#storybook-root') ?? document.querySelector('#root')
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
  const settle = async () => {
    await document.fonts.ready
    await frames()
    await sleep(120)
  }

  /** Until the preview is there and the story has drawn something (or said it could not). */
  const ready = async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const root = storyRoot()
      const drawn = !!root && [...root.children].some(visible)
      const errored = document.body.classList.contains('sb-show-errordisplay')
      if (win.__STORYBOOK_PREVIEW__ && (drawn || errored)) break
      if (!win.__STORYBOOK_PREVIEW__ && drawn) break
      await sleep(100)
    }
    await settle()
  }

  /** Re-render through the preview's channel, as the manager does, and wait for it. */
  const rerender = (event: string, payload: unknown) =>
    new Promise<string | undefined>((resolve) => {
      const channel = win.__STORYBOOK_ADDONS_CHANNEL__
      if (!channel) return resolve('this Storybook has no preview channel')
      let done = false
      const finish = (error?: string) => {
        clearTimeout(timer)
        if (done) return
        done = true
        channel.off('storyRendered', onRendered)
        channel.off('storyErrored', onErrored)
        channel.off('storyThrewException', onErrored)
        resolve(error)
      }
      const onRendered = () => finish()
      const onErrored = (detail: unknown) =>
        finish(String(record(detail).message ?? record(detail).title ?? 'the story failed to render'))
      channel.on('storyRendered', onRendered)
      channel.on('storyErrored', onErrored)
      channel.on('storyThrewException', onErrored)
      const timer = setTimeout(() => finish('Storybook did not acknowledge the render within eight seconds'), 8_000)
      channel.emit(event, payload)
    })

  const meta = async (): Promise<StoryMeta> => {
    await ready()
    if (document.body.classList.contains('sb-show-errordisplay'))
      return { storyId, argTypes: [], error: 'the preview reported a render error' }
    const store = win.__STORYBOOK_PREVIEW__?.storyStoreValue
    if (!store) return { storyId, argTypes: [] }
    let story
    try {
      story = await store.loadStory({ storyId })
    } catch (error) {
      return { storyId, argTypes: [], error: error instanceof Error ? error.message : String(error) }
    }
    const argTypes: StoryArgType[] = []
    for (const [name, raw] of Object.entries(story.argTypes ?? {})) {
      const type = record(raw.type)
      const control = record(raw.control)
      const table = record(raw.table)
      if (control.disable === true || table.disable === true) continue
      const initial = story.initialArgs?.[name]
      const plain = typeof initial === 'string' || typeof initial === 'number' || typeof initial === 'boolean'
      const description = typeof raw.description === 'string' ? raw.description.slice(0, 300) : undefined
      const literals = Array.isArray(raw.options)
        ? raw.options
        : Array.isArray(type.value)
          ? (type.value as unknown[]).map((entry) => (typeof entry === 'object' ? record(entry).value : entry))
          : []
      const options = literals.filter(
        (option): option is string | number => typeof option === 'string' || typeof option === 'number',
      )
      const base = { name, ...(plain ? { initial } : {}), ...(description ? { description } : {}) }
      if (type.name === 'boolean' || control.type === 'boolean') argTypes.push({ ...base, kind: 'boolean' })
      else if (options.length >= 2 && options.length === literals.length)
        argTypes.push({ ...base, kind: 'enum', options })
      else if ((type.name === 'string' || control.type === 'text') && typeof initial === 'string' && initial.trim())
        argTypes.push({ ...base, kind: 'text' })
    }
    const parameters = story.parameters ?? {}
    const docs = record(record(parameters.docs).description)
    const description =
      (typeof docs.component === 'string' && docs.component) ||
      (typeof parameters.componentSubtitle === 'string' && parameters.componentSubtitle) ||
      undefined
    /* a dark theme: a `theme` global with a dark item, else the backgrounds addon's dark */
    const globalTypes = store.projectAnnotations?.globalTypes ?? {}
    let dark: StoryMeta['dark']
    for (const [key, raw] of Object.entries(globalTypes)) {
      const items = record(raw.toolbar).items
      const values = (Array.isArray(items) ? items : []).map((item) =>
        typeof item === 'string' ? item : String(record(item).value ?? ''),
      )
      const value = values.find((item) => /dark/i.test(item))
      if (/theme|mode|scheme/i.test(key) && value) dark = { globals: { [key]: value } }
    }
    if (!dark) {
      const backgrounds = record(parameters.backgrounds)
      const values = Array.isArray(backgrounds.values) ? backgrounds.values : []
      const named = values.map((value) => String(record(value).name ?? '')).find((name) => /dark/i.test(name))
      if (named) dark = { globals: { backgrounds: named } }
    }
    return {
      storyId,
      argTypes,
      ...(description ? { description: description.slice(0, 300) } : {}),
      ...(dark ? { dark } : {}),
    }
  }

  /* -------------------------------------------------------------- */
  /* Capturing                                                      */

  const DARK_MARKER = /(?<![\w-])(?:\.dark|\.theme-dark|\[data-(?:theme|mode|color-scheme)=["']?dark["']?\])(?![\w\\-])/
  /** A selector with its states, pseudo-elements and dark conditions relaxed, to ask whether it
   *  could apply to anything here. A :not() only narrows, and goes first. */
  const relaxed = (selector: string) =>
    selector
      .replace(/(?<!\\):not\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, ':is(*)')
      .replace(/(?<!\\):(?:is|where)\((?:[^()]|\([^()]*\))*\)/g, (group) =>
        DARK_MARKER.test(group) ? ':is(*)' : group,
      )
      .replace(new RegExp(DARK_MARKER.source, 'g'), '*')
      .replace(
        /(?<!\\)::?(?:before|after|placeholder|marker|selection|file-selector-button|backdrop|first-line|first-letter|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?/g,
        ':is(*)',
      )
      .replace(
        /(?<!\\):(?:hover|focus-visible|focus-within|focus|active|visited|link|any-link|disabled|enabled|checked|indeterminate|invalid|valid|required|optional|read-only|read-write|placeholder-shown|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|empty|open|closed|popover-open|autofill|user-invalid|user-valid|target|default|in-range|out-of-range|modal|fullscreen)(?![\w-])/g,
        ':is(*)',
      )
      .replace(
        /(?<!\\):(?:nth-child|nth-last-child|nth-of-type|nth-last-of-type|has|dir|lang)\((?:[^()]|\([^()]*\))*\)/g,
        ':is(*)',
      )
      .trim() || '*'

  const absolute = (text: string, base: string) =>
    text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote: string, ref: string) => {
      if (/^(?:data:|#|[a-z][a-z0-9+.-]*:)/i.test(ref.trim())) return whole
      try {
        return `url("${new URL(ref.trim(), base).href}")`
      } catch {
        return whole
      }
    })

  /** Down through what decorators wrap a story in (theme providers, layout boxes): an element with
   *  no text of its own and one visible child, that is nothing a person would call a part (not a
   *  control, landmark or list) and paints nothing the page does not (a theme provider's
   *  background is the page's). Their custom properties still reach the capture, resolved on the
   *  root it lands on. */
  const unwrap = (start: Element): Element => {
    const TRANSPARENT = /^(?:transparent|rgba\(0, 0, 0, 0\))$/
    const bodyBg = getComputedStyle(document.body).backgroundColor
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor
    const pageBg = !TRANSPARENT.test(bodyBg) ? bodyBg : !TRANSPARENT.test(htmlBg) ? htmlBg : 'rgb(255, 255, 255)'
    const PART =
      'button, a[href], input, select, textarea, label, summary, details, img, svg, picture, video, table, ul, ol, dl, form, fieldset, nav, header, footer, main, section, article, aside, dialog, figure, [role], [tabindex], [contenteditable]'
    const paints = (el: Element) => {
      const style = getComputedStyle(el)
      return (
        (!TRANSPARENT.test(style.backgroundColor) && style.backgroundColor !== pageBg) ||
        style.backgroundImage !== 'none' ||
        style.boxShadow !== 'none' ||
        ['Top', 'Right', 'Bottom', 'Left'].some(
          (side) =>
            parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
            style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none',
        )
      )
    }
    let el = start
    for (let depth = 0; depth < 16; depth++) {
      const children = [...el.children].filter(
        (child) => !['SCRIPT', 'STYLE'].includes(child.tagName) && visible(child),
      )
      const ownText = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())
      if (children.length !== 1 || ownText || el.matches(PART) || paints(el)) return el
      el = children[0]!
    }
    return el
  }

  /* Headless Chromium on Linux can report no pointer. Measure and photograph the
     same desktop layout that the kit emits, including styles added by a variant. */
  const useDesktopMedia = () => {
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) return
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          const pointer = /^\((?:any-)?(?:hover|pointer):\s*(hover|none|fine|coarse)\)$/.exec(rule.conditionText)
          if (pointer) rule.media.mediaText = ['hover', 'fine'].includes(pointer[1]!) ? 'all' : 'not all'
        }
        if (rule instanceof CSSGroupingRule) visit(rule.cssRules)
        else if (rule instanceof CSSImportRule && rule.styleSheet) visitSheet(rule.styleSheet)
      }
    }
    const visitSheet = (sheet: CSSStyleSheet) => {
      try {
        visit(sheet.cssRules)
      } catch {
        /* cross-origin sheets can still render, but their rules cannot be read */
      }
    }
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) visitSheet(sheet)
  }

  const capture = async (inline: boolean, select?: string): Promise<StoryCapture> => {
    useDesktopMedia()
    await settle()
    const warnings: string[] = []
    const holder = storyRoot()
    const kids = holder
      ? [...holder.children].filter((el) => !['SCRIPT', 'STYLE'].includes(el.tagName) && visible(el))
      : []
    let root: Element | null = kids.length === 1 ? unwrap(kids[0]!) : kids.length ? holder : null
    if (select) {
      root = holder?.querySelector(select) ?? document.querySelector(select)
      if (!root) throw new Error(`nothing in the story matches ${select}`)
    }
    if (!root) {
      /* nothing in the story's root: a dialog or popover drew in a portal */
      const portals = [...document.body.children].filter(
        (el) => el !== holder && !el.contains(holder) && !['SCRIPT', 'STYLE'].includes(el.tagName) && visible(el),
      )
      portals.sort((a, b) => {
        const area = (el: Element) => el.getBoundingClientRect().width * el.getBoundingClientRect().height
        return area(b) - area(a)
      })
      root = portals[0] ?? null
      if (root) warnings.push('the story draws in a portal outside its root; the portal was captured')
    }
    if (!root) throw new Error('the story drew nothing visible')
    document.querySelectorAll(`[data-sb-capture-root]`).forEach((el) => el.removeAttribute('data-sb-capture-root'))
    root.setAttribute('data-sb-capture-root', '')
    const live = [root, ...root.querySelectorAll('*')]
    if (live.some((el) => el.shadowRoot)) warnings.push('it uses shadow DOM, which was captured as its light DOM only')
    if (live.some((el) => el.tagName === 'CANVAS'))
      warnings.push('it draws on a <canvas>, which a component cannot hold')

    /* -- markup -- */
    const clone = root.cloneNode(true) as Element
    const cloned = [clone, ...clone.querySelectorAll('*')]
    clone.removeAttribute('data-sb-capture-root')
    for (const el of clone.querySelectorAll('script, noscript, template, [data-sb-capture-root]')) {
      if (el.hasAttribute('data-sb-capture-root')) el.removeAttribute('data-sb-capture-root')
      else el.remove()
    }
    const GENERATED_ID = /^(?:radix-|:r|«r|_r_|base-ui-|headlessui-|react-aria|mui-|mantine-|downshift-|chakra-|id-)/
    for (const el of cloned) {
      if (el.id && GENERATED_ID.test(el.id)) el.removeAttribute('id')
      for (const name of [
        'aria-controls',
        'aria-labelledby',
        'aria-describedby',
        'aria-owns',
        'aria-activedescendant',
      ]) {
        const value = el.getAttribute(name)
        if (value && GENERATED_ID.test(value)) el.removeAttribute(name)
      }
      for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
    }
    /* sources as the browser resolved them; srcset would choose again elsewhere */
    live.forEach((el, index) => {
      const copy = cloned[index]
      if (!copy) return
      if (el instanceof HTMLImageElement) {
        if (el.currentSrc || el.src) copy.setAttribute('src', el.currentSrc || el.src)
        copy.removeAttribute('srcset')
        copy.removeAttribute('sizes')
        copy.removeAttribute('loading')
      } else if (el instanceof HTMLAnchorElement && el.getAttribute('href')) copy.setAttribute('href', el.href)
      const style = copy.getAttribute('style')
      if (style && /url\(/.test(style)) copy.setAttribute('style', absolute(style, location.href))
    })

    /* -- CSS from the CSSOM: CSS-in-JS inserts rules whose <style> serializes empty -- */
    const parentFamily = root.parentElement && getComputedStyle(root.parentElement).fontFamily
    const matchingSelectors = (selectorText: string, elements: Element[]) => {
      const selectors: string[] = []
      let depth = 0
      let start = 0
      for (let i = 0; i < selectorText.length; i++) {
        const char = selectorText[i]
        if (char === '\\') i++
        else if (char === '(' || char === '[') depth++
        else if (char === ')' || char === ']') depth--
        else if (char === ',' && depth === 0) {
          selectors.push(selectorText.slice(start, i))
          start = i + 1
        }
      }
      selectors.push(selectorText.slice(start))
      return selectors.filter((selector) => {
        if (/#storybook|\.sb-|#root\b|docs-story/.test(selector)) return false
        try {
          const test = relaxed(selector)
          return elements.some((el) => el.matches(test))
        } catch {
          return false
        }
      })
    }
    const DOCUMENT_ONLY = /^\s*(?::root|:host|html|body)(?:\s*,\s*(?::root|:host|html|body))*\s*$/
    const kept: string[] = []
    const keyframes = new Map<string, string>()
    const faces: { family: string; text: string }[] = []
    const seen = new Set<CSSStyleSheet>()
    const walk = (rules: CSSRuleList, wrap: string[], base: string) => {
      for (const rule of [...rules]) {
        if (rule instanceof CSSImportRule) {
          if (rule.styleSheet && !seen.has(rule.styleSheet)) {
            seen.add(rule.styleSheet)
            try {
              walk(
                rule.styleSheet.cssRules,
                rule.media.mediaText ? [...wrap, `@media ${rule.media.mediaText}`] : wrap,
                rule.styleSheet.href ?? base,
              )
            } catch {
              /* cross-origin without CORS: its rules cannot be read */
            }
          }
        } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule)
          walk(rule.cssRules, wrap, base)
        else if (rule instanceof CSSMediaRule) {
          if (rule.conditionText !== 'not all')
            walk(rule.cssRules, rule.conditionText === 'all' ? wrap : [...wrap, `@media ${rule.conditionText}`], base)
        } else if (rule instanceof CSSSupportsRule)
          walk(rule.cssRules, [...wrap, `@supports ${rule.conditionText}`], base)
        else if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule)
          walk(
            rule.cssRules,
            [...wrap, `@container ${rule.containerName} ${rule.containerQuery}`.replace(/\s+/g, ' ')],
            base,
          )
        else if (rule instanceof CSSKeyframesRule) keyframes.set(rule.name, rule.cssText)
        else if (rule instanceof CSSFontFaceRule)
          faces.push({
            family: rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim(),
            text: absolute(rule.cssText, base),
          })
        else if (rule instanceof CSSStyleRule) {
          if (DOCUMENT_ONLY.test(rule.selectorText) || !matchingSelectors(rule.selectorText, live).length) continue
          const texts = [absolute(rule.cssText, base)]
          /* The story's parent is absent from the imported component. Resolve explicit
             inheritance on the root at this rule's cascade position and specificity.
             The same selector on descendants must still inherit from their live parent. */
          if (parentFamily && /^(?:inherit|unset)$/.test(rule.style.fontFamily)) {
            const selectors = matchingSelectors(rule.selectorText, [root!]).map((s) => `${s.trim()}:where(.sb-root)`)
            const priority = rule.style.getPropertyPriority('font-family') ? ' !important' : ''
            if (selectors.length) texts.push(`${selectors.join(', ')} { font-family: ${parentFamily}${priority}; }`)
          }
          for (let text of texts) {
            for (const at of [...wrap].reverse()) text = `${at}{${text}}`
            kept.push(text)
          }
        }
      }
    }
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]
    for (const sheet of sheets) {
      if (seen.has(sheet)) continue
      seen.add(sheet)
      try {
        walk(sheet.cssRules, [], sheet.href ?? location.href)
      } catch {
        if (sheet.href) warnings.push(`a stylesheet from ${new URL(sheet.href).host} could not be read (no CORS)`)
      }
    }
    const css = kept.join('\n')
    for (const [name, text] of keyframes)
      if (new RegExp(`animation(?:-name)?\\s*:[^;}]*\\b${name}\\b`).test(css)) kept.push(text)

    /* -- custom properties, resolved where the root is (a decorator may set the theme) -- */
    const computed = getComputedStyle(root)
    const vars: Record<string, string> = {}
    const queue = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!)
    while (queue.length) {
      const name = queue.pop()!
      if (name in vars) continue
      const value = computed.getPropertyValue(name).trim()
      if (!value) continue
      vars[name] = value
      for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) queue.push(match[1]!)
    }

    /* -- the text style it drew with (its own, as computed: what the page and the browser gave
       it, a button's own font included), and the faces of the families it names -- */
    const text: Record<string, string> = {}
    for (const property of [
      'font-family',
      'font-size',
      'font-weight',
      'font-style',
      'line-height',
      'letter-spacing',
      'color',
      '-webkit-font-smoothing',
    ])
      text[property] = computed.getPropertyValue(property).trim()
    const named = [css, ...Object.values(vars), text['font-family'] ?? ''].join('\n').toLowerCase()
    const fontFaces = faces
      .filter((face) => face.family && named.includes(face.family.toLowerCase()))
      .map((face) => face.text)

    /* -- the CLI's Storybook is only reachable from this machine: carry its files along -- */
    let html = clone.outerHTML
    let rules = kept
    let faceTexts = fontFaces
    if (inline) {
      const MAX_FILE = 400_000
      let budget = 6_000_000
      const cache = new Map<string, string | null>()
      const toData = async (url: string): Promise<string | null> => {
        if (cache.has(url)) return cache.get(url)!
        cache.set(url, null)
        try {
          const response = await fetch(url)
          if (!response.ok) return null
          const blob = await response.blob()
          if (blob.size > MAX_FILE || blob.size > budget) return null
          budget -= blob.size
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          })
          cache.set(url, data)
          return data
        } catch {
          return null
        }
      }
      const local = (url: string) => {
        try {
          const target = new URL(url)
          return target.origin === location.origin || /^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(target.hostname)
        } catch {
          return false
        }
      }
      const swap = async (texts: string[]) => {
        const out: string[] = []
        for (const textItem of texts) {
          let next = textItem
          for (const match of textItem.matchAll(/url\("([^"]+)"\)/g)) {
            if (!local(match[1]!)) continue
            const data = await toData(match[1]!)
            if (data) next = next.split(match[1]!).join(data)
          }
          out.push(next)
        }
        return out
      }
      rules = await swap(rules)
      faceTexts = await swap(faceTexts)
      for (const match of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
        const url = match[1]!.replace(/&amp;/g, '&')
        if (!local(url) || !/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url)) continue
        const data = await toData(url)
        if (data) html = html.split(match[1]!).join(data)
      }
    }

    const box = root.getBoundingClientRect()
    return {
      html,
      rules,
      vars,
      fontFaces: faceTexts,
      text,
      width: Math.ceil(box.width),
      height: Math.ceil(box.height),
      warnings,
    }
  }

  try {
    if (command.kind === 'meta') return { kind: 'meta', meta: await meta() }
    if (command.kind === 'args') {
      const error = await rerender(command.reset ? 'resetStoryArgs' : 'updateStoryArgs', {
        storyId,
        ...(command.reset ? {} : { updatedArgs: command.args }),
      })
      await settle()
      return { kind: 'rendered', ...(error ? { error } : {}) }
    }
    if (command.kind === 'globals') {
      const error = await rerender('updateGlobals', { globals: command.globals })
      await settle()
      return { kind: 'rendered', ...(error ? { error } : {}) }
    }
    if (command.kind === 'vars') {
      const at = document.querySelector('[data-sb-capture-root]') ?? storyRoot() ?? document.documentElement
      const style = getComputedStyle(at)
      return {
        kind: 'vars',
        vars: Object.fromEntries(command.names.map((name) => [name, style.getPropertyValue(name).trim()])),
      }
    }
    return { kind: 'capture', capture: await capture(command.inline, command.select) }
  } catch (error) {
    return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
