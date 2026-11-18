import { useMemo } from 'react'
import {
  composeFrame as compose,
  composeFrameHtml,
  sourceOf,
  type ComposedFrame,
  type ComposeOptions,
  type FrameResources,
} from '../../shared/frameCompose'
import type { ClientCanvas } from '../../shared/types'
import { requestFrame } from './frameBridge'
import { useStore } from './store'

/**
 * The browser's side of shared/frameCompose.ts. The store holds each frame's
 * source; the document a frame's iframe shows (or a standalone copy of it) is
 * that source with the canvas's component stylesheets and token values
 * composed in from the store, so a `tokens` or `component` room message
 * restyles every mounted frame without any frame being sent. What comes back
 * from a frame's runtime carries those blocks and is stripped (`frameSource`)
 * before it reaches the store, the undo history or the server.
 */

type Shared = Pick<ClientCanvas, 'tokens' | 'tokenThemes' | 'components'>

const NO_TOKENS: NonNullable<ClientCanvas['tokens']> = []
const NO_THEMES: string[] = []
const NO_COMPONENTS: NonNullable<ClientCanvas['components']> = []

function resourcesOf(canvas: Shared | null | undefined): FrameResources {
  return {
    tokens: canvas?.tokens ?? NO_TOKENS,
    themes: canvas?.tokenThemes ?? NO_THEMES,
    components: canvas?.components ?? NO_COMPONENTS,
  }
}

/** The self-contained document for HTML of the open canvas. */
export function composeFrame(html: string, options?: ComposeOptions): string {
  return html ? composeFrameHtml(html, resourcesOf(useStore.getState().canvas), options) : html
}

/** The source of a document of the open canvas: what the store and the server keep. */
export function frameSource(html: string): string {
  return sourceOf(html, useStore.getState().canvas?.components ?? NO_COMPONENTS)
}

/** The composed document for a frame's HTML and what the canvas supplied to it,
 *  recomputed when the HTML or the canvas's tokens, themes or components change. Both
 *  strings stay equal while nothing the frame uses changed, so an effect keyed on them
 *  does not run for an unrelated token edit. */
export function useComposedFrame(html: string, options?: ComposeOptions): ComposedFrame {
  const tokens = useStore((s) => s.canvas?.tokens ?? NO_TOKENS)
  const themes = useStore((s) => s.canvas?.tokenThemes ?? NO_THEMES)
  const components = useStore((s) => s.canvas?.components ?? NO_COMPONENTS)
  const partial = options?.partial === true
  return useMemo(
    () => (html ? compose(html, { tokens, themes, components }, { partial }) : { html, shared: '' }),
    [html, tokens, themes, components, partial],
  )
}

/** Show `html` (a frame's source) in the frame's runtime, composed. */
export function showFrameHtml(frameId: string, html: string) {
  return requestFrame(frameId, 'doop:html', { html: composeFrame(html) })
}
