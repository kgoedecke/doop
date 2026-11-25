import { mkdir } from 'node:fs/promises'
import { bundleCli } from './doop-cli-bundle.mjs'

/* The doop CLI as the file Doop serves at /cli/doop.mjs, so a server hands out the CLI that
   matches its own tools. Behaviour: .context/reference/agents.md. */
const out = new URL('../public/cli/', import.meta.url)
await mkdir(out, { recursive: true })
await bundleCli(new URL('doop.mjs', out).pathname)
console.log('Built the doop CLI in public/cli')
