import { copyFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { bundleCli, cliManifest } from './doop-cli-bundle.mjs'

/* The doop CLI as the npm package `@doop-design/cli`, written to cli/dist: the one-file bundle
   (the same build Doop serves at /cli/doop.mjs), its manifest (cli/package.json) and its
   README. Published by .github/workflows/publish-cli.yml; see .context/RELEASE.md.

   The manifest's `repository.url` is the repository the package is published from. npm's
   trusted publishing refuses a package whose `repository.url` is not the repository of the
   workflow that publishes it, so it names the one that runs publish-cli.yml: change both
   together. */
const root = new URL('../', import.meta.url)
const out = new URL('cli/dist/', root)
const { name, version } = await cliManifest()

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await bundleCli(new URL('doop.mjs', out).pathname)
await copyFile(new URL('cli/package.json', root), new URL('package.json', out))
await copyFile(new URL('cli/README.md', root), new URL('README.md', out))
/* the licence text ships with the package wherever the repository carries it */
if (existsSync(new URL('LICENSE', root))) await copyFile(new URL('LICENSE', root), new URL('LICENSE', out))
console.log(`Packed ${name}@${version} in cli/dist`)
