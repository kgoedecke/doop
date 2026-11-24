import { build } from 'esbuild'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePath, type Plugin } from 'vite'

/**
 * The frame runtime is built into one classic script and handed to the editor
 * as a string (`import FRAME_RUNTIME from 'virtual:frame-runtime'`), which
 * `FRAME_BOOTSTRAP` inlines into every frame's `srcdoc`. A frame is a
 * sandboxed iframe without `allow-same-origin`, so the script stays inline:
 * loaded from Doop's origin it would need its own CSP, caching and desktop
 * shell rules.
 *
 * esbuild bundles `main.ts` and everything it imports into one IIFE: every
 * module's top level lands in the one function scope, so nothing reaches the
 * window the design's scripts share, as the hand-written closure did. The
 * same plugin serves `bun run dev`, `vite build`, vitest, the browser-test
 * fixture build and Storybook, since they all load vite.config.ts.
 */

export const FRAME_RUNTIME_MODULE = 'virtual:frame-runtime'
const RESOLVED_ID = '\0' + FRAME_RUNTIME_MODULE
const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url))

export interface BuiltFrameRuntime {
  code: string
  /** every source file in the bundle, normalized for Vite's watcher */
  inputs: string[]
}

export async function buildFrameRuntime(): Promise<BuiltFrameRuntime> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    metafile: true,
    legalComments: 'none',
    logLevel: 'silent',
    /* the closure was strict: esbuild emits the directive above the IIFE,
       which makes this one script element strict and nothing else */
    tsconfigRaw: { compilerOptions: { alwaysStrict: true } },
  })
  const code = result.outputFiles[0]?.text ?? ''
  /* the script sits inside <script data-v-boot>: either sequence would end
     or derail it there */
  if (/<\/script|<!--/i.test(code)) throw new Error('frame runtime: the built script cannot be inlined in <script>')
  const inputs = Object.keys(result.metafile.inputs).map((input) => normalizePath(resolve(input)))
  return { code, inputs }
}

export function frameRuntime(): Plugin {
  let built: Promise<BuiltFrameRuntime> | null = null
  let inputs = new Set<string>()
  function current(): Promise<BuiltFrameRuntime> {
    built ??= buildFrameRuntime().catch((error: unknown) => {
      built = null // a syntax error mid-edit: build again on the next request
      throw error
    })
    return built
  }
  return {
    name: 'doop:frame-runtime',
    resolveId(id) {
      return id === FRAME_RUNTIME_MODULE ? RESOLVED_ID : null
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null
      const runtime = await current()
      inputs = new Set(runtime.inputs)
      for (const input of runtime.inputs) this.addWatchFile(input)
      return `export default ${JSON.stringify(runtime.code)}`
    },
    /* `vite build --watch` */
    watchChange(id) {
      if (inputs.has(normalizePath(id))) built = null
    },
    /* the dev server: a changed runtime file rebuilds the script and updates
       the modules that inline it, so open frames load the new runtime */
    handleHotUpdate({ file, server, modules }) {
      if (!inputs.has(normalizePath(file))) return
      built = null
      const runtime = server.moduleGraph.getModuleById(RESOLVED_ID)
      if (!runtime) return
      server.moduleGraph.invalidateModule(runtime)
      return [...modules, runtime]
    },
  }
}
