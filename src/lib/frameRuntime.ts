import FRAME_RUNTIME from 'virtual:frame-runtime'

/**
 * Bootstrap document loaded once per frame iframe. The parent posts HTML in
 * via postMessage and the runtime morphs the live DOM to match — only changed
 * elements are touched, so updates render in place with no white reload flash.
 * Works inside sandbox="allow-scripts" (no same-origin access needed). The
 * runtime is src/frame-runtime/, built into this one inline script.
 */
export const FRAME_BOOTSTRAP = `<!doctype html>
<html><head></head><body><script data-v-boot>
${FRAME_RUNTIME}</script></body></html>`
