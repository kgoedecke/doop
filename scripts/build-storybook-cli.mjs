import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

/* The Storybook CLI (cli/doop-storybook.ts) as one file Doop serves at /cli/doop-storybook.mjs,
   for a Storybook only the developer's machine reaches. Spec: .context/specs/storybook-import.md. */
const out = new URL('../public/cli/', import.meta.url)
await mkdir(out, { recursive: true })
await build({
  entryPoints: [new URL('../cli/doop-storybook.ts', import.meta.url).pathname],
  outfile: new URL('doop-storybook.mjs', out).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  /* the page is handed functions by their source: keep it free of esbuild's helpers */
  keepNames: false,
  minify: false,
})
console.log('Built the Storybook CLI in public/cli')
