import { isDeleted, isHollow, renderRevOf, type ComponentDef } from '../shared/components.ts'
import { renameThemeAttrs } from '../shared/designTokens.ts'
import { INSTANCE_MARK } from './frameRest.ts'

/**
 * A token or theme rename reaches the canvas's own component definitions before any frame is
 * rewritten: a component's stylesheet and markup are composed into every frame using it from
 * its definition, so a definition left naming the old name would put it back (the next
 * update_component writing the old template over the renamed main), and instances whose
 * markup was renamed under their old revision would read as overrides and stop following.
 * Each definition naming the old name is saved as a new revision with the new one, and the
 * instances marked with a revision it moved past are marked with the new one as their frames
 * are rewritten.
 */

/** A token or theme renamed: what the frames and definitions naming it are rewritten for. */
export type TokenRename = { kind: 'token' | 'theme'; from: string; to: string }

/** A component a rename gave a new revision whose markup moved: its instances marked `from`
 *  render as it does now once their own markup is renamed, so they are marked `to`. */
export type MarkAdvance = { id: string; from: number; to: number }

export function renameTokenRefs(html: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.replace(new RegExp(`var\\(\\s*${escaped}(?=\\s*[,)])`, 'g'), `var(${to}`)
}

export function applyRename(html: string, rename: TokenRename): string {
  return rename.kind === 'token'
    ? renameTokenRefs(html, rename.from, rename.to)
    : renameThemeAttrs(html, rename.from, rename.to)
}

/** Does a rename on this canvas reach this definition? Its own active ones with markup: a
 *  linked library definition is changed on its library canvas, a deleted one is frozen. */
function followsRenames(def: ComponentDef): boolean {
  return !def.source?.library && !isDeleted(def) && !isHollow(def)
}

/** A definition's markup and rules with the rename applied, or null when it names neither. */
function renamedContent(
  def: ComponentDef,
  rename: TokenRename,
): Pick<ComponentDef, 'template' | 'css' | 'rawCss' | 'head'> | null {
  const template = applyRename(def.template, rename)
  const css = applyRename(def.css, rename)
  const rawCss = applyRename(def.rawCss, rename)
  const head = def.head.map((tag) => applyRename(tag, rename))
  const same =
    template === def.template &&
    css === def.css &&
    rawCss === def.rawCss &&
    head.every((tag, at) => tag === def.head[at])
  return same ? null : { template, css, rawCss, head }
}

/** Every definition the rename reaches that names the old name, saved (`save`, which sets its
 *  `renderRev`) as a new revision (`bump`) with the new one. Returns the instance marks to move. */
export function renameInComponents(
  defs: readonly ComponentDef[],
  rename: TokenRename,
  bump: (def: ComponentDef) => ComponentDef,
  save: (def: ComponentDef) => ComponentDef,
): MarkAdvance[] {
  const marks: MarkAdvance[] = []
  for (const def of [...defs]) {
    if (!followsRenames(def)) continue
    const content = renamedContent(def, rename)
    if (!content) continue
    const saved = save({ ...bump(def), ...content })
    const [from, to] = [renderRevOf(def), renderRevOf(saved)]
    if (from !== to) marks.push({ id: def.id, from, to })
  }
  return marks
}

/** Instances marked with a revision a rename moved past, marked with the one it moved to. */
export function advanceInstanceMarks(html: string, marks: readonly MarkAdvance[]): string {
  if (!marks.length) return html
  return html.replace(INSTANCE_MARK, (mark: string, id: string, rev: string) => {
    const moved = marks.find((candidate) => candidate.id === id && candidate.from === Number(rev))
    return moved ? mark.replace(/"\d+"$/, `"${moved.to}"`) : mark
  })
}
