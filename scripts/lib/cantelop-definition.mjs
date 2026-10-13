import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Compile the same named App for local setups and hosted Doop builds. */
export async function definitionFor(service) {
  const local = await readFile(join(service, 'cantelop.local.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const manifest = JSON.parse(local ?? (await readFile(join(service, 'cantelop.json'), 'utf8')))
  if (manifest.schema_version !== 3 || !manifest.definition)
    throw new Error('Run cantelop:setup --prepare-only to migrate the local manifest to SDK 1.0.')
  const name = process.env.CANTELOP_APP_SLUG
  if (!name) return { definition: join(service, manifest.definition), dispose: async () => {} }
  if (!/^(?!.*--)[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new Error('Invalid CANTELOP_APP_SLUG name.')
  const source = await readFile(join(service, 'src/cantelop.ts'), 'utf8')
  const definition = join(service, 'src', `.cantelop-build-${randomUUID()}.ts`)
  await writeFile(definition, source.replace("name: 'doop-claude-runtime'", `name: '${name}'`), { flag: 'wx' })
  return { definition, dispose: () => rm(definition, { force: true }) }
}
