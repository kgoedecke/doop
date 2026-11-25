import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

/* The doop CLI (cli/doop.ts) as one dependency-free file, for the two places it ships from:
   Doop's own /cli/doop.mjs (scripts/build-doop-cli.mjs) and the npm package
   (scripts/pack-doop-cli.mjs). One build, so both are the same CLI. */
const root = new URL('../', import.meta.url)

/** The npm package's manifest (cli/package.json). Its version is the CLI's own, released on
 *  its own tag like the desktop app's and the editor extension's (.context/RELEASE.md). */
export async function cliManifest() {
  return JSON.parse(await readFile(new URL('cli/package.json', root), 'utf8'))
}

export async function bundleCli(outfile) {
  const { version } = await cliManifest()
  await build({
    entryPoints: [new URL('cli/doop.ts', root).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    define: { DOOP_CLI_VERSION: JSON.stringify(version) },
    minify: false,
  })
}
