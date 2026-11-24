import type { ElementInfo } from '../lib/frameBridge'
import { isLocked, styleTarget } from './dom'
import { px } from './cssValues'
import { postEdited } from './edit'
import { endStyleEdit, flushStyleSave, styleEdit } from './styles'

/* Image fills: an <img>, or one CSS background image, which the Design
   panel shows and replaces. */

export type ImageFill = NonNullable<ElementInfo['image']>

export function imageFill(el: Element, cs: CSSStyleDeclaration): ImageFill | null {
  if (el.tagName === 'IMG') {
    const img = el as HTMLImageElement
    return { kind: 'img', src: img.currentSrc || img.src || '', size: cs.objectFit, repeat: 'no-repeat' }
  }
  // A single CSS image fill; leave gradients and layered backgrounds intact.
  const match = cs.backgroundImage.match(/^url\("([^"]*)"\)$/)
  return match ? { kind: 'background', src: match[1]!, size: cs.backgroundSize, repeat: cs.backgroundRepeat } : null
}

function preserveImageSize(el: HTMLImageElement, cs: CSSStyleDeclaration): void {
  // Keep the old intrinsic inputs, not the flex/grid layout's used size.
  // This also works without Typed OM and leaves authored widths, heights,
  // flex factors and responsive constraints in charge of the actual box.
  // Already size-contained images (including earlier replacements) do not
  // derive their layout from the file, so keep their existing overrides.
  const contain = cs.contain
  if (!el.naturalWidth || !el.naturalHeight || contain === 'strict' || contain.split(' ').indexOf('size') !== -1) return
  let ratio = cs.aspectRatio
  if (ratio.indexOf('auto') !== -1) {
    ratio = el.naturalWidth + ' / ' + el.naturalHeight
    // A natural ratio applies to the content box; a CSS ratio follows
    // box-sizing. Preserve the current outer ratio for padded border boxes.
    if (cs.boxSizing === 'border-box' && Number(px(cs.width)) > 0 && Number(px(cs.height)) > 0)
      ratio = px(cs.width) + ' / ' + px(cs.height)
  }
  el.style.setProperty('aspect-ratio', ratio, 'important')
  el.style.setProperty('contain-intrinsic-size', el.naturalWidth + 'px ' + el.naturalHeight + 'px', 'important')
  el.style.setProperty(
    'contain',
    contain === 'none' ? 'size' : contain === 'content' ? 'size layout style paint' : contain + ' size',
    'important',
  )
}

export function replaceImage(
  selector: unknown,
  expected: Partial<ImageFill> | null | undefined,
  url: unknown,
): boolean {
  const el = styleTarget(selector)
  if (!el || isLocked(el) || !expected || typeof url !== 'string' || !url) return false
  const cs = getComputedStyle(el)
  const image = imageFill(el, cs)
  if (!image || image.kind !== expected.kind || image.src !== expected.src) return false
  if (styleEdit) endStyleEdit(styleEdit.selector, false)
  flushStyleSave()
  if (image.kind === 'img') {
    const img = el as HTMLImageElement
    preserveImageSize(img, cs)
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      img.parentElement.querySelectorAll('source').forEach((source) => {
        source.remove()
      })
    }
    img.src = url
  } else {
    el.style.setProperty('background-image', 'url(' + JSON.stringify(url) + ')', 'important')
  }
  postEdited(true)
  return true
}
