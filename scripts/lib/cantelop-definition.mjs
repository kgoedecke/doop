import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Select the saved definition and let the SDK override its deployment name. */
export async function definitionFor(service) {
  const local = await readFile(join(service, 'cantelop.local.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const manifest = JSON.parse(local ?? (await readFile(join(service, 'cantelop.json'), 'utf8')))
  if (manifest.schema_version !== 3 || !manifest.definition)
    throw new Error('Run cantelop:setup --prepare-only to migrate the local manifest to SDK 1.0.')
  return {
    definition: join(service, manifest.definition),
    ...(process.env.CANTELOP_APP_SLUG ? { appName: process.env.CANTELOP_APP_SLUG } : {}),
  }
}
