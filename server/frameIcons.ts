import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { getIconAsset, iconAssetSource, iconId } from './iconAssets.ts'
import { iconData, validIconId } from './iconData.ts'

/** A known public Iconify URL or this deployment's own icon route, never an
 * arbitrary same-path URL on another host. */
export function frameIconSource(url: URL, assetOrigin: string): URL | null {
  if (url.origin === assetOrigin && url.pathname.startsWith('/a/iconify/') && !url.username && !url.password) {
    return iconAssetSource(`https://api.iconify.design${url.pathname.slice('/a/iconify'.length)}${url.search}`)
  }
  return iconAssetSource(url.href)
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi

/** Download static icon dependencies before Chrome starts loading a frame.
 * HTML stays unchanged, including element ids and editable inline SVG copies.
 * srcdoc recursion covers the PDF renderer's print shell. */
export async function prepareFrameIcons(html: string, assetOrigin: string): Promise<void> {
  if (!/iconify/i.test(html)) return
  const ids = new Set<string>()
  function scan(documentHtml: string, inheritedBase: string, depth: number): void {
    if (depth > 8) throw new Error('icon document nesting is too deep')
    const document = parse(documentHtml)
    let base = inheritedBase
    let seenBase = false
    function walk(node: DefaultTreeAdapterMap['node'], visit: (node: DefaultTreeAdapterMap['element']) => void): void {
      if ('tagName' in node) visit(node)
      if ('childNodes' in node) for (const child of node.childNodes) walk(child, visit)
    }
    walk(document, (node) => {
      if (node.tagName !== 'base' || seenBase) return
      const href = node.attrs.find((a) => a.name === 'href')?.value
      if (href === undefined) return
      seenBase = true
      try {
        base = new URL(href, inheritedBase).href
      } catch {
        /* invalid base */
      }
    })
    function collect(raw: string): void {
      let url: URL
      try {
        url = new URL(raw, base)
      } catch {
        return
      }
      const source = frameIconSource(url, assetOrigin)
      if (source) ids.add(iconId(source))
    }
    function css(value: string): void {
      for (const match of value.matchAll(CSS_URL)) collect(match[1] ?? match[2] ?? match[3] ?? '')
    }
    walk(document, (node) => {
      for (const attr of node.attrs) {
        if (['src', 'href', 'poster', 'data'].includes(attr.name)) collect(attr.value)
        else if (attr.name === 'srcset')
          for (const candidate of attr.value.split(',')) collect(candidate.trim().split(/\s+/)[0] ?? '')
        else if (attr.name === 'style') css(attr.value)
        else if (attr.name === 'srcdoc') scan(attr.value, base, depth + 1)
      }
      if (node.tagName === 'style') {
        for (const child of node.childNodes) if ('value' in child) css(child.value)
      }
    })
  }
  scan(html, `${assetOrigin}/`, 0)
  await Promise.all([...ids].map((id) => iconData.get(id)))
}

/** This resolver runs before the request guard's trusted/direct-network
 * bypass. Local and hosted Chrome both receive the already cached SVG bytes. */
export async function frameIconResponse(
  url: URL,
  assetOrigin: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const source = frameIconSource(url, assetOrigin)
  return source ? { body: await getIconAsset(source), contentType: 'image/svg+xml' } : null
}

/* A hotlink as frame HTML spells it: slash or colon form, then whatever query
   follows up to the end of the attribute or CSS url(). An attribute's query
   may still be entity-encoded (`&amp;`); it is kept exactly as written. */
const ICONIFY_HOTLINK = /https:\/\/api\.iconify\.design\/([a-z0-9-]+)[/:]([a-z0-9-]+)\.svg((?:\?[^\s"'<>()\\]*)?)/g
const ICON_ROUTE = /\/a\/iconify\/([a-z0-9-]+)\/([a-z0-9-]+)\.svg/g
const MAX_WARMED_ICONS = 512

/** Point every Iconify hotlink the icon route can serve at this deployment's
 * copy, so viewers never burst the public API (it answers a burst with 429).
 * A URL the route would refuse (an unknown parameter) stays as written. */
export function withIconAssets(html: string, assetOrigin: string): string {
  if (!html.includes('api.iconify.design')) return html
  return html.replace(ICONIFY_HOTLINK, (url, prefix: string, name: string, query: string) =>
    iconAssetSource(url.replace(/&amp;/gi, '&')) ? `${assetOrigin}/a/iconify/${prefix}/${name}.svg${query}` : url,
  )
}

/** Start downloading the base icons a saved frame names, so they are stored
 * before anyone opens it. Fire and forget: a failure here only means the
 * first viewer's request does the download instead. */
export function warmFrameIcons(html: string): void {
  if (!html.includes('/a/iconify/')) return
  const ids = new Set<string>()
  for (const [, prefix, name] of html.matchAll(ICON_ROUTE)) {
    const id = `${prefix}:${name}`
    if (validIconId(id)) ids.add(id)
    if (ids.size >= MAX_WARMED_ICONS) break
  }
  for (const id of ids) iconData.get(id).catch(() => {})
}
