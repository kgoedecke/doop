import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

/* The doop CLI (cli/doop.ts) as one dependency-free file, for the two places it ships from:
   Doop's own /cli/doop.mjs (scripts/build-doop-cli.mjs) and the npm package
   (scripts/pack-doop-cli.mjs). One build, so both are the same CLI. */
const root = new URL('../', import.meta.url)

/** The app's version, which is the CLI's: a CLI says which server it was built with. */
export async function appVersion() {
  return JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version
}

export async function bundleCli(outfile) {
  await build({
    entryPoints: [new URL('cli/doop.ts', root).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    define: { DOOP_CLI_VERSION: JSON.stringify(await appVersion()) },
    minify: false,
  })
}
