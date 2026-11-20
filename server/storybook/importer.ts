import type { Actor, Canvas } from '../../shared/types.ts'
import type { DesignTokenInput, TokenEdit } from '../../shared/designTokens.ts'
import { acquireComponent, type ComponentCapture } from '../../shared/storybookAcquire.ts'
import {
  groupComponents,
  parseStoryIndex,
  storybookBase,
  type StorybookComponent,
} from '../../shared/storybookIndex.ts'
import { buildKit, type KitComponent } from '../../shared/storybookKit.ts'
import {
  FIDELITY_WARNING,
  MAX_STORYBOOK_COMPONENTS,
  type StorybookComponentResult,
  type StorybookRunResult,
  type StorybookSourceComponent,
} from '../../shared/storybookSource.ts'
import { webFontByFamily } from '../../shared/webFonts.ts'
import { findComponent } from '../componentActions.ts'
import { store } from '../store.ts'
import { runOperation } from '../workBudget.ts'
import { runCanvasWrite } from '../canvasWrites.ts'
import { runComponentTool, componentWriteNotes, type ToolContext } from '../componentTools.ts'
import { addCanvasFont } from '../canvasFontUpload.ts'
import { createAsset, fetchRemote } from '../assets.ts'
import { openStoryTab } from './browser.ts'
import { fidelityOf } from './fidelity.ts'
import { recordRun, upsertSource, type StorybookSource } from './sources.ts'

/**
 * A Storybook import or sync, end to end: render the picked stories (or take the CLI's
 * captures), build them into components and tokens, and write fonts, tokens and components onto
 * the canvas. Spec: .context/specs/storybook-import.md.
 */

export interface StorybookImportInput {
  canvasId: string
  /** the Storybook, as the person gave it */
  url: string
  /** what to import; empty with `captures` means what the captures are */
  picks: StorybookSourceComponent[]
  /** rendered elsewhere (the CLI, for a Storybook only its machine reaches) */
  captures?: ComponentCapture[]
  user: { id: string; name: string }
  actor: Actor
  /** Only existing, server-loaded sources may span multiple import batches. */
  syncSourceId?: string
  onProgress?: (status: string, done: number, total: number) => void
}

export class StorybookImportError extends Error {}

const MAX_INDEX_BYTES = 20_000_000
const MAX_FONT_FILES = 24
const PARALLEL_TABS = 2

/** The Storybook's components, from its index. */
export async function readStorybook(raw: string): Promise<{ base: URL; components: StorybookComponent[] }> {
  const base = storybookBase(raw)
  let json: unknown
  for (const file of ['index.json', 'stories.json']) {
    try {
      const bytes = await fetchRemote(new URL(file, base).href, MAX_INDEX_BYTES)
      json = JSON.parse(bytes.toString('utf8'))
      break
    } catch {
      /* not JSON: try the other name */
    }
  }
  if (!json)
    throw new StorybookImportError(
      `no Storybook index at ${base.href}: give the address the Storybook is published at (its index.json must be public). For a Storybook only your machine reaches (localhost, behind a VPN), use the CLI.`,
    )
  const components = groupComponents(parseStoryIndex(json))
  if (!components.length) throw new StorybookImportError('that Storybook has no stories')
  return { base, components }
}

/* ------------------------------------------------------------------ */
/* Acquiring                                                           */

async function acquire(
  base: URL,
  wanted: { component: StorybookComponent; pick: StorybookSourceComponent }[],
  report: (status: string) => void,
): Promise<{ captures: ComponentCapture[]; failed: { title: string; reason: string }[] }> {
  const captures: ComponentCapture[] = []
  const failed: { title: string; reason: string }[] = []
  const queue = [...wanted]
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_TABS, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { component, pick } = next
        report(`Rendering ${component.name}`)
        /* a page each: the renderer closes a page held past its lease */
        const tab = await openStoryTab()
        try {
          captures.push(
            await acquireComponent(tab, base, component, {
              ...(pick.storyId ? { storyId: pick.storyId } : {}),
              ...(pick.select ? { select: pick.select } : {}),
            }),
          )
        } catch (error) {
          failed.push({ title: component.title, reason: error instanceof Error ? error.message : String(error) })
        } finally {
          await tab.close()
        }
      }
    }),
  )
  const order = new Map(wanted.map(({ component }, index) => [component.title, index]))
  captures.sort((a, b) => order.get(a.title)! - order.get(b.title)!)
  return { captures, failed }
}

/* ------------------------------------------------------------------ */
/* Files: fonts into the library, pictures into the asset store         */

interface FontFace {
  family: string
  url: string
  ext: string
}

const FORMAT_RANK = ['woff2', 'woff', 'truetype', 'opentype', 'ttf', 'otf']

function parseFace(text: string): FontFace | null {
  const family = /font-family\s*:\s*(["']?)([^;"'}]+)\1/i.exec(text)?.[2]?.trim()
  if (!family) return null
  const sources = [...text.matchAll(/url\(\s*"?([^")]+)"?\s*\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/gi)].map(
    (match) => {
      const url = match[1]!
      const format = (match[2] ?? /\.(woff2|woff|ttf|otf)(?:[?#]|$)/i.exec(url)?.[1] ?? '').toLowerCase()
      return { url, format }
    },
  )
  sources.sort((a, b) => {
    const rank = (format: string) => (FORMAT_RANK.includes(format) ? FORMAT_RANK.indexOf(format) : FORMAT_RANK.length)
    return rank(a.format) - rank(b.format)
  })
  const best = sources[0]
  if (!best) return null
  const ext = { truetype: 'ttf', opentype: 'otf' }[best.format] ?? (best.format || 'woff2')
  return { family, url: best.url, ext }
}

function decodeDataUri(uri: string): Buffer | null {
  const match = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri)
  if (!match) return null
  return match[1] ? Buffer.from(match[2]!, 'base64') : Buffer.from(decodeURIComponent(match[2]!))
}

/** Each face the components use, added to the canvas's font library; families named in CSS
 *  that the library knows by another name are renamed to it. */
async function importFonts(
  canvasId: string,
  user: StorybookImportInput['user'],
  components: KitComponent[],
): Promise<{ added: string[]; notes: string[]; renames: Map<string, string> }> {
  const added = new Set<string>()
  const notes: string[] = []
  const renames = new Map<string, string>()
  const faces = new Map<string, FontFace>()
  for (const text of components.flatMap((component) => component.fontFaces)) {
    const face = parseFace(text)
    if (face && !webFontByFamily(face.family)) faces.set(face.url, face)
  }
  if (faces.size > MAX_FONT_FILES) notes.push(`${faces.size} font files: only the first ${MAX_FONT_FILES} were added`)
  for (const face of [...faces.values()].slice(0, MAX_FONT_FILES)) {
    try {
      const buf = face.url.startsWith('data:') ? decodeDataUri(face.url) : await fetchRemote(face.url, 10_000_000)
      if (!buf) continue
      const font = await addCanvasFont(canvasId, user, buf, `${face.family.replace(/[^\w -]/g, '')}.${face.ext}`)
      added.add(font.family)
      if (font.family.toLowerCase() !== face.family.toLowerCase()) renames.set(face.family, font.family)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!notes.some((note) => note.endsWith(reason))) notes.push(`font “${face.family}” was not added: ${reason}`)
    }
  }
  return { added: [...added], notes, renames }
}

function renameFamilies(text: string, renames: Map<string, string>): string {
  let out = text
  for (const [from, to] of renames) {
    const pattern = new RegExp(`(["'])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'gi')
    out = out.replace(pattern, `"${to}"`)
  }
  return out
}

const DATA_URI = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=\s]+/g

/** Pictures the CLI carried along as data: URIs, into the asset store: a frame never holds base64. */
async function rehostDataUris(
  text: string,
  canvasId: string,
  user: StorybookImportInput['user'],
  cache: Map<string, string>,
): Promise<string> {
  const found = [...new Set(text.match(DATA_URI) ?? [])]
  let out = text
  for (const uri of found) {
    let url = cache.get(uri)
    if (url === undefined) {
      url = ''
      try {
        const buf = decodeDataUri(uri.replace(/\s/g, ''))
        if (buf) {
          const asset = await createAsset(buf, { canvasId, ownerId: user.id, uploadedBy: user.name })
          url = `/a/${asset.id}.${asset.ext}`
        }
      } catch {
        /* not a picture the store takes (a font outside a face, a cursor): left out */
      }
      cache.set(uri, url)
    }
    out = out.split(uri).join(url || 'about:blank')
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */

function toolContext(canvas: Canvas, actor: Actor, userId: string): ToolContext {
  return {
    canvas,
    actor,
    canRead: (id) => id === canvas.id,
    canEdit: (id) => id === canvas.id,
    readableCanvases: () => [canvas],
    userId,
  }
}

async function writeTokens(
  canvasId: string,
  tokens: DesignTokenInput[],
  source: StorybookSource,
  actor: Actor,
): Promise<StorybookRunResult['tokens'] & { errors: Map<string, string> }> {
  const existing = new Map(store.getTokens(canvasId).map((token) => [token.name, token]))
  const ours = new Set(source.tokens)
  const create = tokens.filter((token) => !existing.has(token.name))
  const edits: TokenEdit[] = []
  const leftAlone: string[] = []
  for (const token of tokens) {
    const current = existing.get(token.name)
    if (!current) continue
    if (!ours.has(token.name)) {
      if (current.value !== token.value) leftAlone.push(token.name)
      continue
    }
    const darkNow = current.themes?.dark
    const darkNext = token.themes?.dark
    if (current.value === token.value && darkNow === darkNext) continue
    edits.push({
      name: token.name,
      value: token.value,
      ...(darkNow !== darkNext ? { themes: { dark: darkNext ?? null } } : {}),
    })
  }
  const errors = new Map<string, string>()
  const created: string[] = []
  const updated: string[] = []
  if (create.length) {
    const written = await runOperation('storybook tokens', canvasId, () =>
      runCanvasWrite(canvasId, { type: 'create-tokens', tokens: create, actor }),
    )
    if (!written) throw new StorybookImportError('could not write design tokens')
    for (const result of written.results) {
      if (result.result === 'created') created.push(result.name)
      if (result.result === 'error') errors.set(result.name, result.message)
    }
    if (created.length) await recordRun(source.id, { tokens: [...new Set([...source.tokens, ...created])] })
  }
  if (edits.length) {
    const written = await runOperation('storybook tokens', canvasId, () =>
      runCanvasWrite(canvasId, { type: 'set-tokens', edits, actor }),
    )
    if (!written) throw new StorybookImportError('could not update design tokens')
    for (const result of written.results) {
      if (result.result === 'updated') updated.push(result.name)
      if (result.result === 'error') errors.set(result.name, result.message)
    }
  }
  return { created, updated, leftAlone, errors }
}

function notesOf(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('COMPONENT:'))
    .map((line) => line.replace(/^COMPONENT:\s*/, ''))
}

async function writeComponent(
  canvas: Canvas,
  built: KitComponent,
  known: StorybookSourceComponent | undefined,
  context: ToolContext,
): Promise<{ result: StorybookComponentResult; componentId?: string }> {
  const base = { title: built.title, name: built.name, notes: [...built.notes] }
  const mine = known?.componentId ? findComponent(canvas.id, known.componentId) : undefined
  const mineActive = mine && mine.status !== 'deleted' ? mine : undefined
  if (mineActive && known?.hash === built.hash)
    return { result: { ...base, outcome: 'unchanged', componentId: mineActive.id }, componentId: mineActive.id }
  const sameName = findComponent(canvas.id, built.name)
  if (!mineActive && sameName && sameName.status !== 'deleted')
    return {
      result: {
        ...base,
        outcome: 'skipped',
        notes: [
          ...base.notes,
          `this canvas already has a component named “${built.name}” that this Storybook did not make: left alone. Rename it, or import onto another canvas.`,
        ],
      },
    }
  const input = mineActive
    ? {
        component: mineActive.id,
        html: built.html,
        css: built.css,
        props: built.props,
        description: built.description,
        ...(built.code ? { code: built.code } : {}),
      }
    : {
        name: built.name,
        description: built.description,
        html: built.html,
        css: built.css,
        props: built.props,
        width: built.width,
        height: built.height,
        ...(built.code ? { code: built.code } : {}),
      }
  const outcome = await runOperation('storybook component', canvas.id, () =>
    runComponentTool(mineActive ? 'update_component' : 'create_component', input, context),
  )
  if (!outcome.ok) return { result: { ...base, outcome: 'failed', notes: [...base.notes, outcome.error] } }
  const def = findComponent(canvas.id, mineActive?.id ?? built.name)
  const doopNotes = (outcome.result.frames ?? []).flatMap((frame) => componentWriteNotes(frame)).flatMap(notesOf)
  return {
    result: {
      ...base,
      outcome: mineActive ? 'updated' : 'created',
      ...(def ? { componentId: def.id } : {}),
      notes: [...base.notes, ...doopNotes],
    },
    ...(def ? { componentId: def.id } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* The run                                                             */

export async function runStorybookImport(input: StorybookImportInput): Promise<StorybookRunResult> {
  if (input.syncSourceId && input.picks.length > MAX_STORYBOOK_COMPONENTS) {
    const combined: StorybookRunResult = {
      at: Date.now(),
      components: [],
      tokens: { created: [], updated: [], leftAlone: [] },
      fonts: { added: [], notes: [] },
    }
    for (let offset = 0; offset < input.picks.length; offset += MAX_STORYBOOK_COMPONENTS) {
      const batch = await runStorybookImport({
        ...input,
        picks: input.picks.slice(offset, offset + MAX_STORYBOOK_COMPONENTS),
        onProgress: (status, done, total) =>
          input.onProgress?.(
            status,
            offset + Math.floor((done / total) * Math.min(MAX_STORYBOOK_COMPONENTS, input.picks.length - offset)),
            input.picks.length,
          ),
      })
      combined.components.push(...batch.components)
      for (const key of ['created', 'updated', 'leftAlone'] as const)
        combined.tokens[key] = [...new Set([...combined.tokens[key], ...batch.tokens[key]])]
      for (const key of ['added', 'notes'] as const)
        combined.fonts[key] = [...new Set([...combined.fonts[key], ...batch.fonts[key]])]
    }
    combined.at = Date.now()
    await recordRun(input.syncSourceId, { result: combined })
    return combined
  }
  const { canvasId, user, actor } = input
  const base = storybookBase(input.url)
  const url = base.href
  let done = 0
  let total = 1
  let status = 'Reading the Storybook'
  const report = (next?: string, step = false) => {
    if (next) status = next
    if (step) done++
    input.onProgress?.(status, done, Math.max(total, done))
  }
  report()

  /* what to import: the picks, or what the CLI captured */
  let picks = input.picks
  if (input.captures) {
    const captured = new Map(input.captures.map((capture) => [capture.title, capture]))
    picks = picks.length
      ? picks.filter((pick) => captured.has(pick.title))
      : [...captured.keys()].map((title) => ({ title }))
  }
  if (!picks.length) throw new StorybookImportError('pick at least one component')
  if (picks.length > MAX_STORYBOOK_COMPONENTS)
    throw new StorybookImportError(`an import takes up to ${MAX_STORYBOOK_COMPONENTS} components at a time`)
  const source = await upsertSource(canvasId, url, picks, user.id)
  const known = new Map(source.components.map((component) => [component.title, component]))
  /* a sync of the whole source, or the picks of this run */
  const wantedTitles = new Set(picks.map((pick) => pick.title))
  total = wantedTitles.size * 2 + 3

  const results: StorybookComponentResult[] = []
  let captures: ComponentCapture[]
  if (input.captures) {
    captures = input.captures.filter((capture) => wantedTitles.has(capture.title))
  } else {
    const { components } = await readStorybook(url)
    const byTitle = new Map(components.map((component) => [component.title, component]))
    const wanted: { component: StorybookComponent; pick: StorybookSourceComponent }[] = []
    for (const title of wantedTitles) {
      const component = byTitle.get(title)
      if (component) wanted.push({ component, pick: known.get(title) ?? { title } })
      else
        results.push({
          title,
          name: title.split('/').pop() ?? title,
          outcome: 'failed',
          notes: ['no longer in the Storybook'],
        })
    }
    report('Rendering stories', true)
    const acquired = await acquire(base, wanted, (step) => report(step, true))
    captures = acquired.captures
    for (const failure of acquired.failed)
      results.push({
        title: failure.title,
        name: failure.title.split('/').pop() ?? failure.title,
        outcome: 'failed',
        notes: [failure.reason],
      })
  }

  report('Building components', true)
  const kit = buildKit(captures)
  for (const skipped of kit.skipped)
    results.push({
      title: skipped.title,
      name: skipped.title.split('/').pop() ?? skipped.title,
      outcome: 'skipped',
      notes: [skipped.reason],
    })

  const outcome = await store.withCanvas(canvasId, async (canvas) => {
    if (!canvas) throw new StorybookImportError('canvas not found')
    report('Adding fonts', true)
    const changed = kit.components.filter((component) => {
      const prior = known.get(component.title)
      const def = prior?.componentId && findComponent(canvasId, prior.componentId)
      return !def || def.status === 'deleted' || prior?.hash !== component.hash
    })
    const fonts = await importFonts(canvasId, user, changed)
    for (const prior of known.values())
      for (const [from, to] of Object.entries(prior.fontRenames ?? {}))
        if (!fonts.renames.has(from)) fonts.renames.set(from, to)
    const assets = new Map<string, string>()
    for (const component of changed) {
      component.css = await rehostDataUris(renameFamilies(component.css, fonts.renames), canvasId, user, assets)
      component.html = await rehostDataUris(component.html, canvasId, user, assets)
    }
    const tokens = kit.tokens.map((token) =>
      token.type === 'fontFamily' ? { ...token, value: renameFamilies(token.value, fonts.renames) } : token,
    )
    report('Writing tokens', true)
    const tokenResult = await writeTokens(canvasId, tokens, source, actor)

    const context = toolContext(canvas, actor, user.id)
    for (const built of kit.components) {
      report(`Writing ${built.name}`)
      const errors = [...tokenResult.errors].filter(([name]) => built.css.includes(name))
      if (errors.length) {
        results.push({
          title: built.title,
          name: built.name,
          outcome: 'failed',
          notes: errors.map(([name, message]) => `${name}: ${message}`),
        })
        report(undefined, true)
        continue
      }
      const { result, componentId } = await writeComponent(canvas, built, known.get(built.title), context)
      if (componentId) {
        if (result.outcome !== 'unchanged') {
          known.set(built.title, {
            ...known.get(built.title),
            title: built.title,
            componentId,
            hash: built.hash,
            fontRenames: Object.fromEntries(fonts.renames),
          })
          await recordRun(source.id, { components: [...known.values()] })
        }
        const def = findComponent(canvasId, componentId)
        const main = def?.mainFrameId ? store.getFrame(def.mainFrameId) : undefined
        if (built.screenshot && main && result.outcome !== 'unchanged') {
          const fidelity = await fidelityOf(main, Buffer.from(built.screenshot, 'base64'))
          if (fidelity !== undefined) {
            result.fidelity = fidelity
            if (fidelity < FIDELITY_WARNING)
              result.notes.push(
                `draws ${Math.round(fidelity * 100)}% like its story: compare get_component_preview with the story`,
              )
          }
        }
      }
      results.push(result)
      report(undefined, true)
    }
    return { tokenResult, fonts }
  })

  const order = new Map([...wantedTitles].map((title, index) => [title, index]))
  results.sort((a, b) => (order.get(a.title) ?? 0) - (order.get(b.title) ?? 0))
  const result: StorybookRunResult = {
    at: Date.now(),
    components: results,
    tokens: {
      created: outcome.tokenResult.created,
      updated: outcome.tokenResult.updated,
      leftAlone: outcome.tokenResult.leftAlone,
    },
    fonts: { added: outcome.fonts.added, notes: outcome.fonts.notes },
  }
  await recordRun(source.id, { result })
  return result
}

/** One line a person or agent reads first. */
export function summarize(result: StorybookRunResult): string {
  const count = (outcome: string) => result.components.filter((component) => component.outcome === outcome).length
  const parts = [
    count('created') && `${count('created')} created`,
    count('updated') && `${count('updated')} updated`,
    count('unchanged') && `${count('unchanged')} unchanged`,
    count('skipped') && `${count('skipped')} skipped`,
    count('failed') && `${count('failed')} failed`,
    result.tokens.created.length + result.tokens.updated.length &&
      `${result.tokens.created.length + result.tokens.updated.length} tokens`,
    result.fonts.added.length &&
      `${result.fonts.added.length} font ${result.fonts.added.length === 1 ? 'family' : 'families'}`,
  ].filter(Boolean)
  return parts.length ? `Storybook: ${parts.join(' · ')}` : 'Storybook: nothing to import'
}
