import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { definitionFor } from './lib/cantelop-definition.mjs'

const root = fileURLToPath(new URL('../cantelop/', import.meta.url))
// Use the compiler beside the SDK resolved by the definition's TypeScript
// imports. Separate root/service installs otherwise have distinct class symbols.
const serviceCompiler = new URL('../cantelop/node_modules/@cantelop/sdk/dist/build.js', import.meta.url)
const installed = await access(serviceCompiler).then(
  () => true,
  () => false,
)
const { buildBackendClient } = await import(installed ? serviceCompiler.href : '@cantelop/sdk/build')
const source = await definitionFor(root)
try {
  await buildBackendClient({ definition: source.definition, outdir: `${root}../.cantelop/claude-client` })
  console.log('Built Cantelop 1.0 backend client.')
} finally {
  await source.dispose()
}
