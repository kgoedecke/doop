// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { attributeStyles, importSvgMarkup, looksLikeSvg, type StyleReader } from '../src/lib/svgImport'
import { parseEditablePath, shapePath } from '../src/lib/pathEditing'
import { isCanvasElement } from '../src/lib/drawing'
import { buildLayerTree } from '../src/lib/layers'

const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const shapes = (html: string) => [...doc(html).querySelectorAll<SVGSVGElement>('svg[data-doop-drawing="path"]')]
const style = (el: Element) => (el as HTMLElement).style
const imported = (markup: string, name = 'icon') => importSvgMarkup(markup, name, { key: 'k' })!

describe('importing an SVG file', () => {
  it('makes one path a standalone vector that fills its shell, like a pen path', () => {
    const result = imported(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#f00"/></svg>',
      'arrow',
    )
    expect(isCanvasElement(result.html)).toBe(true)
    const body = doc(result.html).body
    expect(body.children).toHaveLength(1)
    const svg = body.firstElementChild!
    expect(svg.getAttribute('data-doop-drawing')).toBe('path')
    expect(svg.getAttribute('data-name')).toBe('arrow')
    expect(style(svg).width).toBe('100%')
    /* the shell is the ink plus the pen's two px pad, and the viewBox is that box */
    expect({ width: result.width, height: result.height }).toEqual({ width: 20, height: 20 })
    expect(svg.getAttribute('viewBox')).toBe('2 2 20 20')
    const path = shapePath(svg)!
    expect(path.getAttribute('d')).toBe('M 4 4 L 20 4 L 20 20 L 4 20 Z')
    expect(path.getAttribute('fill')).toBe('#f00')
    expect(parseEditablePath(path.getAttribute('d')!)).not.toBeNull()
  })

  it('bakes transforms and the viewBox into the shapes and inherits paint down the tree', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 10 10">
        <g transform="translate(1 1)" fill="red" stroke="blue" stroke-width="0.2">
          <rect id="box" x="0" y="0" width="4" height="4"/>
          <circle cx="7" cy="7" r="2" fill="green"/>
        </g>
      </svg>`)
    const [rect, circle] = shapes(result.html)
    expect(rect!.getAttribute('data-name')).toBe('box')
    expect(circle!.getAttribute('data-name')).toBe('Ellipse')
    /* (0,0)-(4,4) shifted by one and scaled ten times: 10..50 */
    expect(shapePath(rect!)!.getAttribute('d')).toBe('M 10 10 L 50 10 L 50 50 L 10 50 Z')
    expect(shapePath(rect!)!.getAttribute('fill')).toBe('red')
    expect(shapePath(circle!)!.getAttribute('fill')).toBe('green')
    expect(shapePath(circle!)!.getAttribute('stroke')).toBe('blue')
    /* a 0.2 stroke in a space scaled ten times is 2px wide */
    expect(shapePath(circle!)!.getAttribute('stroke-width')).toBe('2')
    /* the shell is the ink's box, and each shape sits in it by percentage */
    /* ink from 10 to 100, each shape padded by its stroke: 8 to 102 */
    expect(result.width).toBeCloseTo(94, 5)
    expect(style(rect!).left).toMatch(/%$/)
    expect(style(rect!).width).toMatch(/%$/)
    expect(doc(result.html).body.firstElementChild!.getAttribute('data-doop-drawing')).toBe('group')
    expect(doc(result.html).body.firstElementChild!.getAttribute('data-name')).toBe('icon')
  })

  it('keeps nested groups and names them, and lists every shape in the Layers tree', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <g id="face">
          <g id="eyes"><circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/></g>
          <path id="mouth" d="M 2 7 Q 5 9 8 7"/>
        </g>
      </svg>`)
    const tree = buildLayerTree(result.html)
    expect(tree).toHaveLength(1)
    const face = tree[0]!
    /* the lone outer group collapsed into the file's own; its children stay */
    expect(face.children.map((c) => c.label)).toEqual(['eyes', 'mouth'])
    expect(face.children[0]!.children.map((c) => c.label)).toEqual(['Ellipse', 'Ellipse'])
    expect(face.children[0]!.children[0]!.kind).toBe('svg')
  })

  it('expands use and symbol in place', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20">
        <defs><symbol id="dot" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></symbol></defs>
        <use xlink:href="#dot" x="2" y="2" width="4" height="4" fill="orange"/>
        <use href="#dot" x="10" y="10" width="4" height="4"/>
      </svg>`)
    const dots = shapes(result.html)
    expect(dots).toHaveLength(2)
    expect(shapePath(dots[0]!)!.getAttribute('fill')).toBe('orange')
    expect(dots[0]!.getAttribute('viewBox')).toBe('0 0 8 8')
    expect(dots[1]!.getAttribute('viewBox')).toBe('8 8 8 8')
  })

  it('carries gradients and clips along with prefixed ids, baking user-space ones onto the shapes', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <defs>
          <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
          <linearGradient id="u" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="10" y2="0"><stop offset="1"/></linearGradient>
          <clipPath id="c"><rect width="5" height="5"/></clipPath>
        </defs>
        <g clip-path="url(#c)" transform="translate(2 0)">
          <rect width="10" height="10" fill="url(#g)"/>
          <rect width="10" height="10" fill="url(#u)" transform="scale(2)"/>
        </g>
      </svg>`)
    const html = result.html
    expect(html).not.toContain('id="g"')
    expect(html).toContain('id="k-g"')
    expect(html).toContain('fill="url(#k-g)"')
    const d = doc(html)
    const clipped = [...d.querySelectorAll<HTMLElement>('[data-doop-drawing="group"]')].find((el) =>
      el.getAttribute('style')!.includes('clip-path:url(#k-c-clip-'),
    )
    expect(clipped).toBeTruthy()
    const clip = d.querySelector('clipPath[id^="k-c-clip-"]')!
    expect(clip.getAttribute('transform')).toMatch(/^matrix\(/)
    /* the copy's own transform rides in the attribute alone: an inline one would win over it */
    expect(clip.getAttribute('style') ?? '').not.toContain('transform')
    const baked = d.querySelector('linearGradient[id^="k-u-baked-"]')!
    expect(baked.getAttribute('gradientTransform')).toBe('matrix(2 0 0 2 2 0)')
    expect(html).toContain(`fill="url(#${baked.getAttribute('id')})"`)
    /* the defs host is one hidden element the Layers panel does not list */
    expect(d.querySelector('[data-doop-defs]')).toBeTruthy()
    expect(buildLayerTree(html)[0]!.children.map((c) => c.label)).not.toContain('svg')
  })

  it('keeps text and images as layers of their own, in the file’s coordinates', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
        <rect width="100" height="50"/>
        <text x="10" y="30" font-size="12" fill="white" transform="rotate(5)">Hello</text>
        <image href="data:image/png;base64,AAAA" width="20" height="20"/>
      </svg>`)
    const d = doc(result.html)
    const layers = d.querySelectorAll('[data-doop-drawing="svg"]')
    expect(layers).toHaveLength(2)
    const text = layers[0]!
    expect(text.getAttribute('data-name')).toBe('Text')
    /* a raw layer spans the whole element: the file's box plus the shapes' pads */
    expect(text.getAttribute('viewBox')).toBe('-2 -2 104 54')
    expect(text.querySelector('g')!.getAttribute('transform')).toMatch(/^matrix\(/)
    expect(text.querySelector('text')!.getAttribute('style')).toContain('fill:white')
    expect(text.querySelector('text')!.getAttribute('style')).toContain('font-size:12')
    expect(layers[1]!.getAttribute('data-name')).toBe('Image')
    /* a raw layer makes the shell the whole file */
    expect({ width: result.width, height: result.height }).toEqual({ width: 104, height: 54 })
    expect(result.layers).toBe(3)
  })

  it('leaves scripts, handlers, foreign content and hidden shapes behind', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
        <script>alert(2)</script>
        <foreignObject><div>html</div></foreignObject>
        <rect width="5" height="5" onclick="alert(3)"/>
        <rect width="5" height="5" display="none"/>
        <rect width="5" height="5" style="visibility:hidden"/>
        <a href="javascript:alert(4)"><rect width="2" height="2"/></a>
      </svg>`)
    expect(result.html).not.toMatch(/script|onload|onclick|javascript:|foreignObject/i)
    expect(shapes(result.html)).toHaveLength(2)
  })

  it('reads physical units and preserves a compound path as one editable shape', () => {
    const result = imported(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><path d="M0 0h10v10H0z M2 2h6v6H2z" fill-rule="evenodd"/></svg>',
    )
    expect(result.width).toBeCloseTo(37.8 + 4, 0)
    const [shape] = shapes(result.html)
    const path = shapePath(shape!)!
    expect(parseEditablePath(path.getAttribute('d')!)!.subpaths).toHaveLength(2)
    expect(path.getAttribute('fill-rule')).toBe('evenodd')
  })

  it('scales stroke widths and dashes with the transform and keeps group opacity on the group', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <g opacity="0.5" transform="scale(2)">
          <line x1="0" y1="0" x2="5" y2="0" stroke="black" stroke-width="1" stroke-dasharray="1 2"/>
          <line x1="0" y1="2" x2="5" y2="2" stroke="black" opacity="0.4"/>
        </g>
      </svg>`)
    const d = doc(result.html)
    /* the file's one group became the root, opacity and all */
    const group = d.querySelector<HTMLElement>('[data-doop-drawing="group"]')!
    expect(group.style.opacity).toBe('0.5')
    const [first, second] = shapes(result.html)
    expect(shapePath(first!)!.getAttribute('stroke-width')).toBe('2')
    expect(shapePath(first!)!.getAttribute('stroke-dasharray')).toBe('2 4')
    expect(second!.getAttribute('opacity')).toBe('0.4')
  })

  it('keeps the root’s own effects and a group’s mask and filter', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" opacity="0.5">
        <defs><mask id="m"><rect width="5" height="10" fill="white"/></mask><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs>
        <g mask="url(#m)" filter="url(#f)"><rect width="10" height="10"/><rect width="2" height="2"/></g>
      </svg>`)
    const d = doc(result.html)
    const root = d.querySelector<HTMLElement>('body > [data-doop-drawing="group"]')!
    expect(root.getAttribute('style')).toContain('opacity:0.5')
    const masked = [...d.querySelectorAll<HTMLElement>('[data-doop-drawing="group"]')].find((el) =>
      el.getAttribute('style')!.includes('mask:url(#k-m-mask-'),
    )!
    expect(masked.getAttribute('style')).toContain('filter:url(#k-f)')
    expect(
      importSvgMarkup(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" display="none"><rect width="1" height="1"/></svg>',
        'x',
      ),
    ).toBeNull()
  })

  it('takes transforms and gradient stop colours from the style reader, as a stylesheet sets them', () => {
    /* a reader standing in for the browser's computed styles: `.part` moves
       and `.warm` stops are red, as a <style> block would say */
    const styled: StyleReader = (el, property) => {
      if (property === 'transform' && el.getAttribute('class') === 'part') return 'translate(20px, 0px)'
      if (property === 'stop-color' && el.getAttribute('class') === 'warm') return 'rgb(255, 0, 0)'
      return attributeStyles(el, property)
    }
    const result = importSvgMarkup(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs><linearGradient id="g"><stop class="warm" offset="0"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
        <rect class="part" width="10" height="10" fill="url(#g)"/>
      </svg>`,
      'styled',
      { key: 'k', styles: styled },
    )!
    const [shape] = shapes(result.html)
    expect(shapePath(shape!)!.getAttribute('d')).toBe('M 20 0 L 30 0 L 30 10 L 20 10 Z')
    expect(doc(result.html).querySelector('stop')!.getAttribute('style')).toContain('stop-color:rgb(255, 0, 0)')
  })

  it('moves a user-space mask along with the shape it masks, and leaves a bounding-box one alone', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
        <defs>
          <mask id="m"><rect width="5" height="10" fill="white"/></mask>
          <mask id="b" maskContentUnits="objectBoundingBox"><rect width="0.5" height="1" fill="white"/></mask>
          <mask id="u" maskUnits="userSpaceOnUse" maskContentUnits="objectBoundingBox" x="0" y="0" width="10" height="10"><rect width="1" height="1" fill="white"/></mask>
        </defs>
        <g transform="translate(20 0)">
          <rect mask="url(#m)" width="10" height="10" transform="scale(2)"/>
          <rect mask="url(#b)" width="10" height="10"/>
          <rect mask="url(#u)" width="10" height="10"/>
        </g>
      </svg>`)
    const d = doc(result.html)
    const [moved, boxed, bounded] = shapes(result.html).map((svg) => shapePath(svg)!.getAttribute('mask'))
    /* bounds in user units move with the shape too, content in its box stays put */
    const sized = d.querySelector(`mask[id="${bounded!.slice(5, -1)}"]`)!
    expect(sized.getAttribute('id')).toMatch(/^k-u-mask-/)
    expect(['x', 'y', 'width', 'height'].map((n) => sized.getAttribute(n))).toEqual(['20', '0', '10', '10'])
    expect(sized.firstElementChild!.localName).toBe('rect')
    /* bounds in ems resolve against the mask's own font size, which the copy keeps: left as written */
    const em = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
        <mask id="e" maskUnits="userSpaceOnUse" font-size="32" x="0" y="0" width="1em" height="1em"><rect width="40" height="40" fill="white"/></mask>
        <rect mask="url(#e)" width="10" height="10" transform="translate(20 0)"/>
      </svg>`)
    const kept = doc(em.html).querySelector('mask[id^="k-e-mask-"]')!
    expect(['x', 'width'].map((n) => kept.getAttribute(n))).toEqual(['0', '1em'])
    expect(kept.querySelector('g')!.getAttribute('transform')).toBe('matrix(1 0 0 1 20 0)')
    expect(moved).toMatch(/^url\(#k-m-mask-\d+\)$/)
    /* the copy's content wears the shape's whole transform, since the shape's points do too */
    const copy = d.querySelector(`mask[id="${moved!.slice(5, -1)}"]`)!
    expect(copy.firstElementChild!.localName).toBe('g')
    expect(copy.firstElementChild!.getAttribute('transform')).toBe('matrix(2 0 0 2 20 0)')
    expect(copy.querySelector('rect')!.getAttribute('width')).toBe('5')
    expect(boxed).toBe('url(#k-b)')
    /* the original stays for anything else that names it */
    expect(d.querySelector('mask[id="k-m"]')).toBeTruthy()
  })

  it('keeps the effects a stylesheet gives text and images, and does not apply their opacity twice', () => {
    const styled: StyleReader = (el, property) => {
      if (property === 'clip-path' && el.getAttribute('class') === 'cut') return 'url("#c")'
      if (property === 'filter' && el.localName === 'text') return 'url("#f")'
      return attributeStyles(el, property)
    }
    const result = importSvgMarkup(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
        <defs>
          <clipPath id="c"><rect width="10" height="10"/></clipPath>
          <filter id="f"><feGaussianBlur stdDeviation="1"/></filter>
          <mask id="m"><rect width="10" height="10" fill="white"/></mask>
        </defs>
        <text x="10" y="30" opacity="0.5">Hello</text>
        <image class="cut" href="data:image/png;base64,AAAA" width="20" height="20" style="opacity:0.5;mask:url(#m)"/>
      </svg>`,
      'effects',
      { key: 'k', styles: styled },
    )!
    const [text, image] = [...doc(result.html).querySelectorAll('[data-doop-drawing="svg"]')]
    expect(text!.getAttribute('opacity')).toBe('0.5')
    expect(text!.querySelector('text')!.hasAttribute('opacity')).toBe(false)
    expect(text!.querySelector('text')!.getAttribute('style')).toContain('filter:url(#k-f)')
    expect(image!.getAttribute('opacity')).toBe('0.5')
    const img = image!.querySelector('image')!
    expect(img.getAttribute('style')).not.toContain('opacity')
    expect(img.getAttribute('style')).toContain('clip-path:url(#k-c)')
    expect(img.getAttribute('style')).toContain('mask:url(#k-m)')
  })

  it('folds a clip’s own transform into its copy without an inline value shadowing it', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <defs><clipPath id="c" transform="translate(1 0)"><rect width="5" height="5"/></clipPath></defs>
        <rect clip-path="url(#c)" width="10" height="10" transform="scale(2)"/>
      </svg>`)
    const clip = doc(result.html).querySelector('clipPath[id^="k-c-clip-"]')!
    expect(clip.getAttribute('transform')).toBe('matrix(2 0 0 2 2 0)')
    expect(clip.getAttribute('style') ?? '').not.toContain('transform')
  })

  it('centres a nested svg’s viewBox in its box by default', () => {
    const result = imported(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
        <rect width="100" height="50" fill="none" stroke="black"/>
        <svg x="0" y="0" width="100" height="50" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>
      </svg>`)
    const inner = shapes(result.html)[1]!
    /* a square viewBox in a 2:1 box: scaled to 50 and centred, 25 to 75 */
    expect(shapePath(inner)!.getAttribute('d')).toBe('M 25 0 L 75 0 L 75 50 L 25 50 Z')
  })

  it('returns null for markup that is not SVG or draws nothing', () => {
    expect(importSvgMarkup('<div>no</div>', 'x')).toBeNull()
    expect(importSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>', 'x')).toBeNull()
    expect(looksLikeSvg('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg viewBox="0 0 1 1"/>')).toBe(true)
    expect(looksLikeSvg('<svgfoo>')).toBe(false)
    expect(looksLikeSvg('hello <svg>')).toBe(false)
  })
})
