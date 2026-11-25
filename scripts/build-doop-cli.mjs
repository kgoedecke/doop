import { build } from 'esbuild'
import { mkdir, readFile } from 'node:fs/promises'

/* The doop CLI (cli/doop.ts) as one dependency-free file Doop serves at /cli/doop.mjs, so a
   server hands out the CLI that matches its own tools. Behaviour: .context/reference/agents.md. */
const out = new URL('../public/cli/', import.meta.url)
await mkdir(out, { recursive: true })
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await build({
  entryPoints: [new URL('../cli/doop.ts', import.meta.url).pathname],
  outfile: new URL('doop.mjs', out).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: { DOOP_CLI_VERSION: JSON.stringify(version) },
  minify: false,
})
console.log('Built the doop CLI in public/cli')
