import sharp from 'sharp'
import type { Frame } from '../../shared/types.ts'
import { loadFramePage } from '../screenshot.ts'
import { COMPONENT_ATTR } from '../../shared/components.ts'

/**
 * How closely a component's main draws like the story it was lifted from: both rendered, sized
 * alike, compared pixel by pixel. A guide, not a proof: antialiasing and a font loading a moment
 * late cost a percent or two. Spec: .context/specs/storybook-import.md, "Writing".
 */

/* a channel this far apart is a different colour, not antialiasing */
const CHANNEL_TOLERANCE = 32
const MAX_FIDELITY_PIXELS = 4_000_000

/** The share of matching pixels between two PNGs, 0-1, a size mismatch counted against it. */
export async function comparePngs(a: Buffer, b: Buffer): Promise<number> {
  const [left, right] = await Promise.all([
    sharp(a, { limitInputPixels: MAX_FIDELITY_PIXELS }).metadata(),
    sharp(b, { limitInputPixels: MAX_FIDELITY_PIXELS }).metadata(),
  ])
  const width = left.width ?? 0
  const height = left.height ?? 0
  const otherWidth = right.width ?? 0
  const otherHeight = right.height ?? 0
  if (
    !width ||
    !height ||
    !otherWidth ||
    !otherHeight ||
    width * height > MAX_FIDELITY_PIXELS ||
    otherWidth * otherHeight > MAX_FIDELITY_PIXELS
  )
    return 0
  const sizeMatch =
    (Math.min(width, otherWidth) / Math.max(width, otherWidth)) *
    (Math.min(height, otherHeight) / Math.max(height, otherHeight))
  const raw = (png: Buffer) =>
    sharp(png, { limitInputPixels: MAX_FIDELITY_PIXELS })
      .flatten({ background: '#ffffff' })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer()
  const [pixels, otherPixels] = await Promise.all([raw(a), raw(b)])
  const channels = pixels.length / (width * height)
  let differ = 0
  for (let at = 0; at < pixels.length; at += channels) {
    for (let channel = 0; channel < Math.min(3, channels); channel++) {
      if (Math.abs(pixels[at + channel]! - otherPixels[at + channel]!) > CHANNEL_TOLERANCE) {
        differ++
        break
      }
    }
  }
  return (1 - differ / (width * height)) * sizeMatch
}

/** The main as the canvas draws it, against the story's screenshot. Undefined when it cannot be
 *  rendered (the renderer is busy or away): the import does not wait on a guide. */
export async function fidelityOf(main: Frame, storyPng: Buffer): Promise<number | undefined> {
  try {
    const loaded = await loadFramePage(main, { priority: 'background' })
    try {
      /* the story was captured light; a renderer on a machine set to dark would paint the
         transparent page dark and count every pixel of it against the component */
      await loaded.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
      const root = await loaded.page.$(`[${COMPONENT_ATTR}]`)
      const box = await root?.boundingBox()
      if (
        !root ||
        !box ||
        box.width < 1 ||
        box.height < 1 ||
        Math.ceil(box.width) * Math.ceil(box.height) > MAX_FIDELITY_PIXELS
      )
        return undefined
      const ours = Buffer.from(await root.screenshot({ type: 'png' }))
      return Math.round((await comparePngs(storyPng, ours)) * 1000) / 1000
    } finally {
      await loaded.close()
    }
  } catch (error) {
    console.warn('[storybook] fidelity render failed', main.id, error instanceof Error ? error.message : error)
    return undefined
  }
}
