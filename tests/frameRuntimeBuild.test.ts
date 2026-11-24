import { describe, expect, it } from 'vitest'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'
import { buildFrameRuntime } from '../src/frame-runtime/vitePlugin'

/* The frame runtime is TypeScript bundled into one inline script
   (src/frame-runtime/vitePlugin.ts). What every frame's srcdoc relies on:
   one strict IIFE that leaves nothing on the window the design shares, and
   nothing that would end the <script> element it sits in. */
describe('the built frame runtime', () => {
  it('is one strict IIFE that can sit inside a script element', async () => {
    const { code } = await buildFrameRuntime()
    expect(code.startsWith('"use strict";\n(() => {\n')).toBe(true)
    expect(code.trimEnd().endsWith('})();')).toBe(true)
    expect(code).not.toMatch(/<\/script|<!--/i)
  })

  it('lists its sources so the dev server rebuilds it when one changes', async () => {
    const { inputs } = await buildFrameRuntime()
    expect(inputs.some((input) => input.endsWith('src/frame-runtime/main.ts'))).toBe(true)
    expect(inputs.some((input) => input.endsWith('shared/prototype.ts'))).toBe(true)
  })

  it('is what FRAME_BOOTSTRAP inlines, through the vite plugin', async () => {
    const { code } = await buildFrameRuntime()
    expect(FRAME_BOOTSTRAP).toContain(`<script data-v-boot>\n${code}</script>`)
  })
})
