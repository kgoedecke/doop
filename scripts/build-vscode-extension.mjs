/* Builds the Doop extension for VS Code and its forks (vscode-extension/):
   one esbuild bundle at vscode-extension/out/extension.js. `--vsix` also
   packs dist/doop.vsix with vsce, for installing by hand or publishing. */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

const root = new URL('../vscode-extension/', import.meta.url).pathname
await build({
  entryPoints: [`${root}src/extension.ts`],
  outfile: `${root}out/extension.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  minify: true,
  sourcemap: false,
})
console.log('Built vscode-extension/out/extension.js')

if (process.argv.includes('--vsix')) {
  await mkdir(`${root}dist`, { recursive: true })
  execFileSync('bunx', ['@vscode/vsce@3.6.0', 'package', '--no-dependencies', '-o', 'dist/doop.vsix'], {
    cwd: root,
    stdio: 'inherit',
  })
}
