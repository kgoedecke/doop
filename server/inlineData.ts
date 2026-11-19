/**
 * Base64 in HTML an agent submits: data: URIs, and long blocks of base64 text that are
 * not one. A frame is stored whole, sent whole to every viewer on each edit and read whole
 * by agents, and every earlier state of it is kept whole too, so a font, picture or clip
 * pasted into it as base64 costs every one of those round-trips (one frame carried a 40 KB
 * TTF per weight). Agent writes that add one are refused with what to do instead; the
 * files go in by URL.
 *
 * A block of base64 with no `data:` in front of it is the same thing unlabelled. A canvas of
 * 91 frames each held 6 MB of it in string literals: gzipped script bundles and a JSON file
 * of pre-rendered pages, unpacked in the browser with `atob`. Fifty kept versions of each
 * frame came to 13 GB of the design history (measured 2026-11-19 UTC).
 *
 * Only what the write ADDS is refused: base64 the frame already holds (a PDF import embeds
 * its fonts this way) may be carried over by a rewrite or an edit around it, or an agent
 * could never touch such a frame again. A block may also come back smaller or in pieces (a
 * span cut out of it, two blocks joined): what counts is how much of it the frame did not hold.
 */

import type { Frame } from '../shared/types.ts'
import { compactFrameHtml } from './componentActions.ts'
import { composedHtml } from './frameCompose.ts'

export type Surface = 'mcp' | 'resident'

export interface InlineData {
  /** `EMBEDDED` for a block of base64 text that is not a data: URI */
  mime: string
  /** decoded size, roughly: three bytes per four base64 characters */
  bytes: number
}

/** What a block of base64 outside a data: URI is listed as: it names no type of its own. */
export const EMBEDDED = 'embedded/base64'

/** A run of base64 characters this long, with nothing else in it, is data and not markup,
 *  code or a URL: 4,096 characters is 3 KB of bytes, where the longest thing a design writes
 *  that way (an integrity hash, an id, a signed URL's token) is a few hundred. */
export const EMBEDDED_MIN_LENGTH = 4096

const DATA_URI = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9-]+=[^;,"'()\s]*)*);base64,([a-z0-9+/=_-]*)/gi

/** What the frame already holds, or how to read it: read only once a candidate is found, and
 *  then once, since working out every form a frame was read in (`heldForms`) is not free. */
export type Existing = string | (() => string)

/** The base64 in `submitted` that `existing` does not already hold: its data: URIs, and its
 *  blocks of base64 text that are not one. */
export function newInlineData(submitted: string, held: Existing = ''): InlineData[] {
  let read: string | undefined
  const existingText = () => (read ??= typeof held === 'function' ? held() : held)
  const found: InlineData[] = []
  /* where each data: URI's payload ends, by where it starts: counted here, not again below */
  const payloads = new Map<number, number>()
  if (/;base64,/i.test(submitted)) {
    for (const match of submitted.matchAll(DATA_URI)) {
      const payload = match[3] ?? ''
      const end = match.index + match[0].length
      payloads.set(end - payload.length, end)
      const existing = existingText()
      if (existing && existing.includes(match[0])) continue
      found.push({
        mime: (match[1] ?? 'application/octet-stream').toLowerCase(),
        bytes: Math.floor((payload.length * 3) / 4),
      })
    }
  }
  if (submitted.length < EMBEDDED_MIN_LENGTH) return found
  for (const run of base64Runs(submitted)) {
    /* only a real data: URI's payload is let through: `;base64,` in front of a block, with
       no `data:` before it, labels nothing */
    const uriEnd = payloads.get(run.start)
    if (uriEnd !== undefined && uriEnd >= run.end) continue
    const existing = existingText()
    const added = existing ? addedTo(submitted.slice(run.start, run.end), existing, run.chars) : run.chars
    if (added < EMBEDDED_MIN_LENGTH) continue
    found.push({ mime: EMBEDDED, bytes: Math.floor((added * 3) / 4) })
  }
  return found
}

/* A-Z a-z 0-9 + / and the URL-safe - _ */
const BASE64_CHAR = new Uint8Array(128)
for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_') {
  BASE64_CHAR[char.charCodeAt(0)] = 1
}

const isBase64 = (text: string, at: number) => {
  const code = text.charCodeAt(at)
  return code < 128 && BASE64_CHAR[code] === 1
}

/* What base64 is broken up by and still decodes through: `atob` skips whitespace, so a block
   wrapped at 64 or 76 columns is one block, and so is one written as "…" + "…" or continued
   over lines with a backslash. */
const JOIN = /(?:\\\r?\n|["'`]\s*\+\s*["'`]|\s)+/y

/** A line this long with nothing but base64 characters is not a word: after one, a run goes
 *  on across a join. Prose is words of a few letters, so it never does. */
const WRAPPED_LINE_MIN = 32

interface Base64Run {
  start: number
  end: number
  /** base64 characters in it, the joins between its lines left out */
  chars: number
}

/** Every run of at least `EMBEDDED_MIN_LENGTH` base64 characters. One pass over the text: a
 *  pattern with a minimum length walks each shorter run again from every one of its
 *  characters. */
function base64Runs(text: string): Base64Run[] {
  const runs: Base64Run[] = []
  let at = 0
  while (at < text.length) {
    if (!isBase64(text, at)) {
      at++
      continue
    }
    const start = at
    let chars = 0
    let end = at
    for (;;) {
      const line = at
      while (at < text.length && isBase64(text, at)) at++
      chars += at - line
      end = at
      if (at - line < WRAPPED_LINE_MIN) break
      JOIN.lastIndex = at
      const next = JOIN.test(text) ? JOIN.lastIndex : at
      if (next === at || next >= text.length || !isBase64(text, next)) break
      at = next
    }
    if (chars >= EMBEDDED_MIN_LENGTH) runs.push({ start, end, chars })
  }
  return runs
}

/* a piece of a block the frame held, to count as carried over, and how far to step past text
   it did not hold; a block is looked for as at most this many pieces */
const HELD_PIECE_MIN = 256
const HELD_PIECES_MAX = 8

/** How many characters of this run the frame did not already hold. Nothing, when the frame
 *  holds the run whole; else the run is read as pieces of what the frame held (what is left
 *  of a block after a span was cut out of it, two blocks joined), and what lies between and
 *  around them is counted. A run with no such piece in it is all new. */
function addedTo(run: string, existing: string, chars: number): number {
  if (existing.includes(run)) return 0
  let added = 0
  let pieces = 0
  let at = 0
  while (at < run.length) {
    const held = pieces < HELD_PIECES_MAX ? heldPrefix(run, at, existing) : 0
    if (held) {
      pieces++
      at += held
      continue
    }
    added += Math.min(HELD_PIECE_MIN, run.length - at)
    at += HELD_PIECE_MIN
    /* enough to refuse, and no piece of it was the frame's: the whole run is what was added */
    if (added >= EMBEDDED_MIN_LENGTH && !pieces) return chars
  }
  return added
}

/** The length of the longest stretch of `run` from `at` that `existing` holds, or 0 when it
 *  holds not even a short one. A stretch of a held stretch is held, so the length is found
 *  by halving. */
function heldPrefix(run: string, at: number, existing: string): number {
  let low = HELD_PIECE_MIN
  if (run.length - at < low || !existing.includes(run.substr(at, low))) return 0
  let high = run.length - at
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (existing.includes(run.substr(at, middle))) low = middle
    else high = middle - 1
  }
  return low
}

type Kind = 'font' | 'svg' | 'image' | 'media' | 'embedded' | 'other'

function kindOf(mime: string): Kind {
  if (mime === EMBEDDED) return 'embedded'
  if (mime.startsWith('font/') || /font|fontobject|opentype|truetype|woff/.test(mime)) return 'font'
  if (mime === 'image/svg+xml') return 'svg'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'media'
  return 'other'
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function advice(kind: Kind, surface: Surface): string {
  switch (kind) {
    case 'font':
      return surface === 'mcp'
        ? 'a font: add the file with upload_font (local_file=true for a file on your machine, source_url for a public one), then name its family in CSS (font-family: "Family", sans-serif); Doop writes the @font-face. A family on Google Fonts can load with a <link> instead.'
        : 'a font: add the file with upload_font (source_url of a public copy of the file), then name its family in CSS (font-family: "Family", sans-serif); Doop writes the @font-face. A family on Google Fonts can load with a <link> instead.'
    case 'svg':
      return 'an SVG: write the <svg> element into the markup, or URL-encode it as data:image/svg+xml,… (no base64) when it is a small CSS background.'
    case 'image':
      return surface === 'mcp'
        ? 'a picture: upload it with upload_asset and use the URL it returns, or find one with search_images, search_icons or generate_image.'
        : 'a picture: find one with search_images, search_icons or generate_image and use the URL it returns, or draw it as inline SVG/CSS.'
    case 'media':
      return 'video or audio: frames are designs, so show a poster image (search_images, generate_image) or link a hosted file by URL.'
    case 'embedded':
      return 'a block of base64 text (a packed script bundle, a compressed data file, a file as a string): a library loads from a CDN with <script src> or <link>; data in a design is a few representative rows written out, not the dataset; a picture goes in by the URL upload_asset, search_images or generate_image returns, and a font with upload_font. A frame is one screen of a design: an application with its code and all its pages packed inside does not belong in one. Put each screen in a frame of its own and wire them as a prototype.'
    case 'other':
      return 'a file: reference it by a hosted URL, or leave it out of the design.'
  }
}

/** What to tell an agent whose write added base64 data, or null when it added none. */
export function inlineDataRefusal(
  submitted: string | undefined,
  existing: Existing = '',
  surface: Surface = 'mcp',
): string | null {
  if (!submitted) return null
  const found = newInlineData(submitted, existing)
  if (!found.length) return null
  const uris = found.filter((item) => item.mime !== EMBEDDED)
  const blocks = found.filter((item) => item.mime === EMBEDDED)
  const sum = (items: readonly InlineData[]) => size(items.reduce((total, item) => total + item.bytes, 0))
  const count = (many: number, one: string) => `${many} ${one}${many === 1 ? '' : 's'}`
  const embeds = [
    ...(uris.length
      ? [
          `${count(uris.length, 'base64 data: URI')} (${[...new Set(uris.map((item) => item.mime))].join(', ')}; ${sum(uris)})`,
        ]
      : []),
    ...(blocks.length ? [`${count(blocks.length, 'block')} of base64 text (${sum(blocks)})`] : []),
  ]
  const kinds = [...new Set(found.map((item) => kindOf(item.mime)))]
  return [
    `Refused, nothing was written: this HTML embeds ${embeds.join(' and ')}.`,
    'A frame is sent whole to every viewer and agent on each edit, and every earlier state of it is kept, so files go in by URL, never inline. For each one:',
    ...kinds.map((kind) => `- ${advice(kind, surface)}`),
    `Then send the HTML again without the ${uris.length ? 'data: URIs' : 'base64'}${uris.length && blocks.length ? ' and the base64 blocks' : ''}.`,
  ].join('\n')
}

/** A frame's HTML in every form an agent may have read it in (stored, compact, and the full
 *  form with what the canvas supplies): what a write may carry over without adding it, for
 *  `inlineDataRefusal`'s `existing`. One rule for MCP set_frame_html and the canvas write
 *  entry's edits (server/canvasWrites.ts). */
export function heldForms(frame: Frame): string {
  return `${frame.html}\n${compactFrameHtml(frame)}\n${composedHtml(frame.canvasId, frame.html)}`
}

/** A frame's stored HTML, what the resident counts as already in a frame, or nothing while
 *  its HTML is not in memory. */
export function storedHtmlOf(frame: { html: string }): string {
  try {
    return typeof frame.html === 'string' ? frame.html : ''
  } catch {
    return ''
  }
}
