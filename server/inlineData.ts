/**
 * Base64 data: URIs in HTML an agent submits. A frame is stored whole, sent
 * whole to every viewer on each edit and read whole by agents, so a font,
 * picture or clip pasted into it as base64 costs every one of those
 * round-trips (one frame carried a 40 KB TTF per weight). Agent writes that
 * add one are refused with what to do instead; the files go in by URL.
 *
 * Only what the write ADDS is refused: a URI the frame already holds (a PDF
 * import embeds its fonts this way) may be carried over by a rewrite or an
 * edit around it, or an agent could never touch such a frame again.
 */

export type Surface = 'mcp' | 'resident'

export interface InlineData {
  mime: string
  /** decoded size, roughly: three bytes per four base64 characters */
  bytes: number
}

const DATA_URI = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9-]+=[^;,"'()\s]*)*);base64,([a-z0-9+/=_-]*)/gi

/** The base64 data: URIs in `submitted` that `existing` does not already hold. */
export function newInlineData(submitted: string, existing = ''): InlineData[] {
  if (!/;base64,/i.test(submitted)) return []
  const found: InlineData[] = []
  for (const match of submitted.matchAll(DATA_URI)) {
    if (existing && existing.includes(match[0])) continue
    found.push({
      mime: (match[1] ?? 'application/octet-stream').toLowerCase(),
      bytes: Math.floor(((match[3] ?? '').length * 3) / 4),
    })
  }
  return found
}

type Kind = 'font' | 'svg' | 'image' | 'media' | 'other'

function kindOf(mime: string): Kind {
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
    case 'other':
      return 'a file: reference it by a hosted URL, or leave it out of the design.'
  }
}

/** What to tell an agent whose write added base64 data, or null when it added none. */
export function inlineDataRefusal(
  submitted: string | undefined,
  existing = '',
  surface: Surface = 'mcp',
): string | null {
  if (!submitted) return null
  const found = newInlineData(submitted, existing)
  if (!found.length) return null
  const total = found.reduce((sum, item) => sum + item.bytes, 0)
  const mimes = [...new Set(found.map((item) => item.mime))]
  const kinds = [...new Set(found.map((item) => kindOf(item.mime)))]
  return [
    `Refused, nothing was written: this HTML embeds ${found.length} base64 data: URI${found.length === 1 ? '' : 's'} (${mimes.join(', ')}; ${size(total)}).`,
    'A frame is sent whole to every viewer and agent on each edit, so files go in by URL, never inline. For each one:',
    ...kinds.map((kind) => `- ${advice(kind, surface)}`),
    'Then send the HTML again without the data: URIs.',
  ].join('\n')
}
