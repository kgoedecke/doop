import { sniffMime } from '../shared/mediaTypes'
import { PrivateMaterializationError } from '../shared/privateMedia'
import * as css from 'css-tree'
import type { PrivateMaterializer } from '../src/lib/privateMaterialization'

/** Standalone synthetic rendering fixtures have no application server. This
 * adapter proves layout/serialization only, never authorization, intrinsic
 * decode admission, or budget enforcement by the server. */
export const fixturePrivateMaterializer: PrivateMaterializer = async (source, _context, _signal, syntax) => {
  const resources = []
  if (syntax === 'value') {
    let uri = ''
    css.walk(css.parse(source, { context: 'value' }), (node) => {
      if (node.type === 'Url') uri = node.value
    })
    const match = /^data:([^;,]+);base64,(.*)$/.exec(uri)
    if (!match) {
      return {
        html: source,
        replacements: [],
        privateMedia: false,
        costs: { resources: [], references: 1, parserWork: 0, expandedBytes: source.length },
      }
    }
    // Signature-only fixture sanity check; no intrinsic decode/admission claim.
    if (match[1]!.startsWith('image/') && !sniffMime(Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0))))
      throw new PrivateMaterializationError('invalid')
    let identity = 2166136261
    for (const char of uri) identity = Math.imul(identity ^ char.charCodeAt(0), 16777619)
    resources.push({
      key: `inline:fixture:${identity >>> 0}`,
      mime: match[1]!,
      encodedBytes: atob(match[2]!).length,
      decodedBytes: 0, // Layout fixture; the real API owns media validation.
    })
  }
  return {
    html: source,
    replacements: [],
    privateMedia: false,
    costs: {
      resources,
      references: resources.length,
      parserWork: 0,
      expandedBytes: new TextEncoder().encode(source).byteLength,
    },
  }
}
