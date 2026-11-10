import { Router } from 'express'
import {
  colorToString,
  flipFromString,
  iconToHTML,
  iconToSVG,
  rotateFromString,
  stringToColor,
  type IconifyIconCustomisations,
} from '@iconify/utils'
import { iconData, IconNotFoundError, IconUnavailableError, validIconId } from './iconData.ts'

const ICONIFY_ORIGIN = 'https://api.iconify.design'
const ICON_PATH = /^\/([a-z0-9-]+)[/:]([a-z0-9-]+)\.svg$/
const PARAMETERS = new Set(['color', 'height', 'width', 'flip', 'rotate', 'box', 'download'])

export function iconId(source: URL): string {
  const match = ICON_PATH.exec(source.pathname)
  return match ? `${match[1]}:${match[2]}` : ''
}

/** Both the documented slash form and existing colon-form Iconify URLs. */
export function iconAssetSource(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.origin !== ICONIFY_ORIGIN || url.username || url.password || !validIconId(iconId(url))) return null
  const seen = new Set<string>()
  for (const [name, value] of url.searchParams) {
    if (!PARAMETERS.has(name) || seen.has(name) || value.length > 128) return null
    seen.add(name)
  }
  try {
    customisations(url)
  } catch {
    return null
  }
  url.hash = ''
  url.searchParams.sort()
  return url
}

export function iconAssetUrl(id: string, origin: string): string {
  if (!validIconId(id)) throw new Error('invalid Iconify icon id')
  return `${new URL(origin).origin}/a/iconify/${id.replace(':', '/')}.svg`
}

function customisations(source: URL): { options: IconifyIconCustomisations; color?: string } {
  const options: IconifyIconCustomisations = {}
  for (const name of ['width', 'height'] as const) {
    const value = source.searchParams.get(name)
    if (value === null) continue
    if (!/^(?:auto|unset|none|(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|%)?)$/.test(value))
      throw new Error('invalid icon dimension')
    if (Number.parseFloat(value) > 4096) throw new Error('icon dimension is too large')
    options[name] = value
  }
  const flip = source.searchParams.get('flip')
  if (flip) {
    if (!/^(horizontal|vertical)([ ,]+(horizontal|vertical))*$/.test(flip)) throw new Error('invalid icon flip')
    flipFromString(options, flip)
  }
  const rotate = source.searchParams.get('rotate')
  if (rotate) {
    if (!/^-?\d+(?:\.\d+)?(?:deg|%)?$/.test(rotate) || Math.abs(Number.parseFloat(rotate)) > 36000)
      throw new Error('invalid icon rotation')
    options.rotate = rotateFromString(rotate)
  }
  const rawColor = source.searchParams.get('color')
  if (rawColor === null) return { options }
  const color = stringToColor(rawColor)
  if (!color) throw new Error('invalid icon color')
  return { options, color: colorToString(color) }
}

/** Variants are derived from a copy; neither the cached original nor another
 * user's instance is ever mutated. Icons with fixed palettes retain them. */
export async function getIconAsset(source: URL): Promise<Buffer> {
  const canonical = iconAssetSource(source.href)
  if (!canonical) throw new Error('invalid Iconify SVG URL')
  const { options, color } = customisations(canonical)
  const icon = await iconData.get(iconId(canonical))
  const svg = iconToSVG(icon, options)
  let body = color ? svg.body.replace(/currentColor/g, () => color) : svg.body
  if (canonical.searchParams.get('box') === '1' || canonical.searchParams.get('box') === 'true') {
    const [x, y, width, height] = svg.viewBox
    body = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none"/>${body}`
  }
  return Buffer.from(iconToHTML(body, svg.attributes))
}

export const iconAssetsRouter = Router()

iconAssetsRouter.get('/:prefix/:name.svg', async (req, res) => {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
  const source = iconAssetSource(`${ICONIFY_ORIGIN}/${req.params.prefix}/${req.params.name}.svg${query}`)
  if (!source) {
    res.status(400).end()
    return
  }
  try {
    const body = await getIconAsset(source)
    res.set({
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
    if (source.searchParams.get('download') === '1') res.attachment(`${req.params.name}.svg`)
    res.send(body)
  } catch (error) {
    if (error instanceof IconNotFoundError) {
      res.status(404).end()
      return
    }
    res
      .set('Retry-After', String(error instanceof IconUnavailableError ? error.retryAfter : 5))
      .status(503)
      .end()
  }
})
