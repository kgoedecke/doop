import { parse, defaultTreeAdapter, type DefaultTreeAdapterTypes } from 'parse5'
import * as css from 'css-tree'
import { parseSrcset, stringifySrcset } from 'srcset'
import { PRIVATE_MEDIA_LIMITS } from './privateMedia.ts'

export const PRIVATE_REFERENCE_LIMITS = {
  bytes: 1024 * 1024,
  depth: 32,
  work: PRIVATE_MEDIA_LIMITS.parserWork,
  references: 64,
} as const
export class PrivateReferenceError extends Error {}
export interface PrivateReference {
  id: string
  ext: string
  url: string
  hash: string
}
type Edit = { start: number; end: number; text: string }
type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element
export type PrivateUrlKind = 'media' | 'stylesheet' | 'other'
export interface ReferencePolicy {
  base?: string
  url?: (raw: string, base: string, kind: PrivateUrlKind) => string | void
  element?: (tag: string, attributes: Readonly<Record<string, string>>) => void
  work?: (count: number) => void
}

function refuse(reason: string): never {
  throw new PrivateReferenceError(reason)
}

/** Only this configured origin's canonical asset paths denote private resources. */
export function privateAssetUrl(raw: string, origin: string, base = origin): PrivateReference | undefined {
  let url: URL
  try {
    url = new URL(raw, base)
    const canonical = new URL(raw, origin)
    // A document base cannot disguise the reserved local private-file path.
    if (canonical.origin === new URL(origin).origin && canonical.pathname.startsWith('/a/')) url = canonical
  } catch {
    return undefined
  }
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/a/')) return undefined
  const match = /^\/a\/([A-Za-z0-9_-]+)\.(png|jpg|webp|gif|svg|woff2|woff|ttf|otf)$/.exec(url.pathname)
  if (!match || url.username || url.password || url.search) refuse('unsupported private asset URL')
  return { id: match[1]!, ext: match[2]!, url: url.href, hash: url.hash }
}

function apply(source: string, edits: Edit[]): string {
  let end = source.length
  let out = ''
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > end || edit.start < 0 || edit.end < edit.start) refuse('overlapping private URL carriers')
    out = edit.text + source.slice(edit.end, end) + out
    end = edit.start
  }
  return source.slice(0, end) + out
}

/** Validation leaves the original source byte-for-byte intact. Only an explicit
 *  visitor replacement rewrites a URL carrier, as required by an authorized copy. */
export function visitPrivateReferences(
  source: string,
  origin: string,
  visit: (reference: PrivateReference) => string | void,
  context: 'html' | 'stylesheet' | 'declarationList' | 'value' = 'html',
  policy?: ReferencePolicy,
): string {
  if (
    source.length > PRIVATE_REFERENCE_LIMITS.bytes ||
    new TextEncoder().encode(source).byteLength > PRIVATE_REFERENCE_LIMITS.bytes
  )
    refuse('private HTML exceeds the source budget')
  let work = 0
  let references = 0
  const tick = (count = 1) => {
    if ((work += count) > PRIVATE_REFERENCE_LIMITS.work) refuse('private reference work budget exceeded')
    policy?.work?.(count)
  }
  const replaceUrl = (raw: string, base: string, kind: PrivateUrlKind = 'other') => {
    const ref = privateAssetUrl(raw, origin, base)
    const rewritten = policy?.url?.(raw, base, kind)
    if (!ref) return rewritten ?? raw
    if (++references > PRIVATE_REFERENCE_LIMITS.references) refuse('too many private references')
    return visit(ref) ?? rewritten ?? raw
  }

  function stylesheet(
    value: string,
    context: 'stylesheet' | 'declarationList' | 'value',
    base: string,
    inheritedDepth: number,
  ): string {
    const closing: number[] = []
    css.tokenize(value, (type) => {
      tick()
      if ([css.tokenTypes.BadUrl, css.tokenTypes.BadString].includes(type)) refuse('malformed CSS URL')
      if (type === css.tokenTypes.Function || type === css.tokenTypes.LeftParenthesis)
        closing.push(css.tokenTypes.RightParenthesis)
      else if (type === css.tokenTypes.LeftCurlyBracket) closing.push(css.tokenTypes.RightCurlyBracket)
      else if (type === css.tokenTypes.LeftSquareBracket) closing.push(css.tokenTypes.RightSquareBracket)
      else if (
        [css.tokenTypes.RightParenthesis, css.tokenTypes.RightCurlyBracket, css.tokenTypes.RightSquareBracket].includes(
          type,
        ) &&
        closing.pop() !== type
      )
        refuse('unbalanced CSS reference carrier')
      if (inheritedDepth + closing.length > PRIVATE_REFERENCE_LIMITS.depth) refuse('CSS nesting budget exceeded')
    })
    // CSS closes still-open blocks/functions at EOF, including streamed styles.
    // Let the public parser apply that grammar; the stack above bounds its work.
    let ast: css.CssNode
    try {
      ast = css.parse(value, {
        context,
        positions: true,
        parseCustomProperty: true,
        onParseError: () => refuse('malformed CSS reference carrier'),
      })
    } catch (error) {
      if (error instanceof PrivateReferenceError) throw error
      refuse('malformed CSS reference carrier')
    }
    const edits: Edit[] = []
    const parents: css.CssNode[] = []
    const handled = new Set<css.CssNode>()
    function replace(node: css.CssNode, raw: string, asUrl: boolean, kind: PrivateUrlKind = 'media') {
      const next = replaceUrl(raw, base, kind)
      if (next === raw) return
      if (!node.loc) refuse('CSS reference location is missing')
      edits.push({
        start: node.loc.start.offset,
        end: node.loc.end.offset,
        text: asUrl ? `url(${css.string.encode(next)})` : css.string.encode(next),
      })
    }
    css.walk(ast, {
      enter(node: css.CssNode) {
        tick()
        const parent = parents.at(-1)
        const importUrl =
          parent?.type === 'AtrulePrelude' &&
          parents.at(-2)?.type === 'Atrule' &&
          css.ident.decode((parents.at(-2) as css.Atrule).name).toLowerCase() === 'import' &&
          parent.children.first === node
        if (!parents.some((p) => handled.has(p))) {
          if (node.type === 'Raw') refuse('unsupported CSS reference syntax')
          if (node.type === 'Url') replace(node, node.value, true, importUrl ? 'stylesheet' : 'media')
          else if (node.type === 'Function' && css.ident.decode(node.name).toLowerCase() === 'url') {
            // Escaped function identifiers are parsed generically by css-tree.
            // Reparse their ordinary URL spelling with the same public parser.
            const original = value.slice(node.loc!.start.offset, node.loc!.end.offset)
            let decoded: css.CssNode
            try {
              decoded = css.parse(`url${original.slice(original.indexOf('('))}`, { context: 'value' })
            } catch {
              refuse('unsupported CSS URL function')
            }
            const child = decoded.type === 'Value' ? decoded.children.first : undefined
            if (!child || child.type !== 'Url') refuse('unsupported CSS URL function')
            replace(node, child.value, true, importUrl ? 'stylesheet' : 'media')
            handled.add(node)
          } else if (node.type === 'String') {
            const imageSet =
              parent?.type === 'Function' &&
              ['image-set', '-webkit-image-set'].includes(css.ident.decode(parent.name).toLowerCase())
            if (imageSet || importUrl) replace(node, node.value, false, importUrl ? 'stylesheet' : 'media')
          }
        }
        parents.push(node)
      },
      leave() {
        parents.pop()
      },
    })
    return apply(value, edits)
  }

  function html(value: string, base: string, inheritedDepth: number): string {
    const depths = new WeakMap<Node, number>()
    const attach = (parent: DefaultTreeAdapterTypes.ParentNode, child: DefaultTreeAdapterTypes.ChildNode) => {
      const depth = (depths.get(parent) ?? inheritedDepth) + 1
      if (depth > PRIVATE_REFERENCE_LIMITS.depth) refuse('HTML nesting budget exceeded')
      depths.set(child, depth)
    }
    const adapter: typeof defaultTreeAdapter = {
      ...defaultTreeAdapter,
      createElement(name, namespace, attrs) {
        tick(1 + attrs.length)
        return defaultTreeAdapter.createElement(name, namespace, attrs)
      },
      createCommentNode(data) {
        tick()
        return defaultTreeAdapter.createCommentNode(data)
      },
      insertText(parent, text) {
        tick()
        defaultTreeAdapter.insertText(parent, text)
      },
      insertTextBefore(parent, text, reference) {
        tick()
        defaultTreeAdapter.insertTextBefore(parent, text, reference)
      },
      appendChild(parent, child) {
        attach(parent, child)
        defaultTreeAdapter.appendChild(parent, child)
      },
      insertBefore(parent, child, reference) {
        attach(parent, child)
        defaultTreeAdapter.insertBefore(parent, child, reference)
      },
    }
    const document = parse(value, { sourceCodeLocationInfo: true, treeAdapter: adapter })
    const nodes: { node: Node; depth: number; parent?: Node; inTemplate?: boolean }[] = []
    const pending: typeof nodes = [{ node: document as Node, depth: inheritedDepth }]
    while (pending.length) {
      const item = pending.pop()!
      if (item.depth > PRIVATE_REFERENCE_LIMITS.depth) refuse('HTML nesting budget exceeded')
      nodes.push(item)
      const element = item.node as Element
      const children = 'childNodes' in item.node ? item.node.childNodes : []
      pending.push(
        ...children
          .map((node) => ({ node, depth: item.depth + 1, parent: item.node, inTemplate: item.inTemplate }))
          .reverse(),
      )
      if (element.tagName === 'template')
        pending.push({
          node: (element as DefaultTreeAdapterTypes.Template).content,
          depth: item.depth + 1,
          parent: item.node,
          inTemplate: true,
        })
    }
    const firstBase = nodes
      .filter(({ inTemplate }) => !inTemplate)
      .map(({ node }) => node as Element)
      .find(
        (element) =>
          element.tagName === 'base' &&
          element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
          element.attrs.some((a) => a.name === 'href'),
      )
    if (firstBase) {
      try {
        base = new URL(firstBase.attrs.find((a) => a.name === 'href')!.value, base).href
      } catch {
        refuse('invalid document base URL')
      }
    }
    const edits: Edit[] = []
    const urlAttributes = new Set([
      'src',
      'href',
      'poster',
      'data',
      'background',
      'action',
      'formaction',
      'cite',
      'longdesc',
      'manifest',
    ])
    const presentation = new Set([
      'fill',
      'stroke',
      'filter',
      'clip-path',
      'mask',
      'marker',
      'marker-start',
      'marker-mid',
      'marker-end',
      'cursor',
      'color-profile',
    ])
    for (const { node, depth } of nodes) {
      const element = node as Element
      // xml:base is inert in HTML documents, including inline SVG (native Chrome probe).
      const nodeBase = base
      if (!element.tagName) continue
      policy?.element?.(
        element.tagName,
        Object.fromEntries(
          element.attrs.map((attr) => [attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, attr.value]),
        ),
      )
      for (const attr of element.attrs) {
        let next = attr.value
        if (attr.name === 'style') next = stylesheet(next, 'declarationList', nodeBase, depth)
        else if (element.namespaceURI === 'http://www.w3.org/2000/svg' && presentation.has(attr.name))
          next = stylesheet(next, 'value', nodeBase, depth)
        else if (attr.name === 'srcdoc') next = html(next, nodeBase, depth)
        else if (attr.name === 'srcset' || attr.name === 'imagesrcset') {
          let candidates
          try {
            candidates = parseSrcset(next, { strict: true })
          } catch {
            refuse('malformed srcset reference carrier')
          }
          tick(candidates.length)
          const replaced = candidates.map((candidate) => ({
            ...candidate,
            url: replaceUrl(candidate.url, nodeBase, 'media'),
          }))
          if (replaced.some((candidate, i) => candidate.url !== candidates[i]!.url)) {
            // 5.0.2's strict stringifier calls its descriptor validator without
            // the descriptor string. Input and generated output remain strict.
            next = stringifySrcset(replaced)
            try {
              parseSrcset(next, { strict: true })
            } catch {
              refuse('invalid rewritten srcset')
            }
          }
        } else if (attr.name === 'ping')
          next = next
            .split(/\s+/)
            .map((url) => replaceUrl(url, nodeBase))
            .join(' ')
        else if (urlAttributes.has(attr.name) && element.tagName !== 'base') {
          const rel =
            element.attrs
              .find((value) => value.name === 'rel')
              ?.value.toLowerCase()
              .split(/\s+/) ?? []
          const as = element.attrs.find((value) => value.name === 'as')?.value.toLowerCase()
          const visual =
            ['poster', 'background'].includes(attr.name) ||
            (['src', 'href'].includes(attr.name) &&
              [
                'img',
                'input',
                'image',
                'feimage',
                'use',
                'video',
                'audio',
                'source',
                'track',
                'font-face-uri',
              ].includes(element.tagName.toLowerCase())) ||
            (element.tagName === 'link' &&
              attr.name === 'href' &&
              (rel.includes('icon') || ['image', 'font', 'audio', 'video'].includes(as ?? '')))
          const kind: PrivateUrlKind =
            element.tagName === 'link' && attr.name === 'href' && rel.includes('stylesheet')
              ? 'stylesheet'
              : visual
                ? 'media'
                : 'other'
          next = replaceUrl(next, nodeBase, kind)
        }
        if (next === attr.value) continue
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name
        const location = element.sourceCodeLocation?.attrs?.[name]
        if (!location) refuse('HTML reference location is missing')
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          text: `${name}="${next.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`,
        })
      }
      if (element.tagName === 'style') {
        for (const child of element.childNodes) {
          if (child.nodeName !== '#text') continue
          const text = child as DefaultTreeAdapterTypes.TextNode
          const next = stylesheet(text.value, 'stylesheet', nodeBase, depth)
          if (next === text.value) continue
          const location = text.sourceCodeLocation
          if (!location) refuse('stylesheet location is missing')
          edits.push({
            start: location.startOffset,
            end: location.endOffset,
            text: next.replace(/<\/style/gi, '<\\/style'),
          })
        }
      }
    }
    return apply(value, edits)
  }
  const base = policy?.base ?? origin
  return context === 'html' ? html(source, base, 0) : stylesheet(source, context, base, 0)
}
