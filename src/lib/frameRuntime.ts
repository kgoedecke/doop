import FRAME_RUNTIME from 'virtual:frame-runtime'
import { getTheme, resolveTheme, type ResolvedTheme } from './theme'

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

const placeholders: Partial<Record<ResolvedTheme, string>> = {}

function loadingStyle(theme: ResolvedTheme): string {
  const [paper, border, block] =
    theme === 'dark' ? ['#232325', '#3a3a40', '#303035'] : ['#f7f7f7', '#dcdcdc', '#f0f0f0']
  return `<style>
    body::before {
      --block: linear-gradient(${block} 0 0);
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        var(--block) 20% 8% / 44% 1.4% no-repeat,
        var(--block) center 22% / 76% 12% no-repeat,
        var(--block) center 48% / 76% 8% no-repeat,
        var(--block) center 73% / 76% 6% no-repeat,
        ${paper};
      box-shadow: inset 0 0 0 1px ${border};
    }

    @media (max-width: 480px) {
      body::before {
        background:
          var(--block) center 21% / 64% 5% no-repeat,
          var(--block) center 46% / 64% 5% no-repeat,
          var(--block) center 77% / 64% 5% no-repeat,
          ${paper};
      }
    }
  </style>`
}

/** Choose once at mount. The first HTML morph replaces the bootstrap's head. */
export function canvasFrameBootstrap(hasArtwork: boolean): string {
  if (!hasArtwork) return FRAME_BOOTSTRAP
  try {
    if (localStorage.getItem('doop:frame-loading-placeholder') !== '1') return FRAME_BOOTSTRAP
  } catch {
    return FRAME_BOOTSTRAP
  }
  const theme = resolveTheme(getTheme())
  return (placeholders[theme] ??= FRAME_BOOTSTRAP.replace('<head></head>', `<head>${loadingStyle(theme)}</head>`))
}
