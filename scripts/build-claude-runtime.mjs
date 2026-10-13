import { buildAppArtifacts } from '../cantelop/node_modules/@cantelop/sdk/dist/build.js'
import { fileURLToPath } from 'node:url'
import { definitionFor } from './lib/cantelop-definition.mjs'

const root = fileURLToPath(new URL('../cantelop/', import.meta.url))
const source = await definitionFor(root)
try {
  await buildAppArtifacts({ definition: source.definition, outdir: `${root}.cantelop/artifacts`, projectRoot: root })
  console.log('Built SDK 1.0 Edge, Session runtime and backend artifacts.')
} finally {
  await source.dispose()
}
