import { buildAppArtifacts } from '../cantelop/node_modules/@cantelop/sdk/dist/build.js'
import { fileURLToPath } from 'node:url'
import { definitionFor } from './lib/cantelop-definition.mjs'

const root = fileURLToPath(new URL('../cantelop/', import.meta.url))
const definition = await definitionFor(root)
await buildAppArtifacts({ ...definition, outdir: `${root}.cantelop/artifacts`, projectRoot: root })
console.log('Built SDK Claude artifacts.')
