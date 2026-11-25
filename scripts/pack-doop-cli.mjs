import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { appVersion, bundleCli } from './doop-cli-bundle.mjs'

/* The doop CLI as the npm package `@doop-design/cli`, written to cli/dist: the one-file bundle
   (the same build Doop serves at /cli/doop.mjs), a manifest made here and the package's README.
   The manifest is not a file in the repository: its version is the app's (package.json), so the
   two cannot drift. Published by .github/workflows/publish-cli.yml; see .context/RELEASE.md. */
const PACKAGE_NAME = '@doop-design/cli'
/* The repository the package is published from. npm's trusted publishing refuses a package
   whose `repository.url` is not the repository of the workflow that publishes it, so this is
   the one that runs publish-cli.yml: change both together. */
const PUBLISHED_FROM = 'https://github.com/doop-design/doop-internal'

const root = new URL('../', import.meta.url)
const out = new URL('cli/dist/', root)
const version = await appVersion()

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await bundleCli(new URL('doop.mjs', out).pathname)

const manifest = {
  name: PACKAGE_NAME,
  version,
  description: 'Design on a Doop canvas from a shell: frames and components as local files, for coding agents and CI.',
  keywords: ['doop', 'design', 'canvas', 'cli', 'mcp', 'ai-agents'],
  homepage: 'https://doop.design/docs/cli',
  repository: { type: 'git', url: `git+${PUBLISHED_FROM}.git` },
  bugs: { url: 'https://github.com/doop-design/doop/issues' },
  license: 'AGPL-3.0-only',
  type: 'module',
  bin: { doop: 'doop.mjs' },
  files: ['doop.mjs', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
}
await writeFile(new URL('package.json', out), `${JSON.stringify(manifest, null, 2)}\n`)
await copyFile(new URL('cli/README.md', root), new URL('README.md', out))
/* the licence text ships with the package wherever the repository carries it */
if (existsSync(new URL('LICENSE', root))) await copyFile(new URL('LICENSE', root), new URL('LICENSE', out))
console.log(`Packed ${PACKAGE_NAME}@${version} in cli/dist`)
