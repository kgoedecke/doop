import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateActors } from './generate-actors.mjs'

await generateActors(true)

const root = fileURLToPath(new URL('../', import.meta.url))
const config = path.resolve(process.argv[2] || path.join(root, 'terse.config.json'))
const staging = await mkdtemp(path.join(tmpdir(), 'doop-deploy-'))
try {
  // Explicit deployment inputs keep app data and local secrets out of the archive.
  for (const file of [
    'src/actor.ts',
    'server/escapedHtml.ts',
    'server/limits.ts',
    'shared/types.ts',
    'shared/pages.ts',
    'shared/frame-validation.ts',
    'shared/billing.ts',
  ]) {
    const target = path.join(staging, file)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.join(root, file), target)
  }
  for (const file of ['package.json', 'tsconfig.json'])
    await copyFile(path.join(root, 'actors', file), path.join(staging, file))
  await copyFile(config, path.join(staging, 'terse.config.json'))
  await symlink(path.join(root, 'node_modules'), path.join(staging, 'node_modules'), 'dir')
  const child = spawn(process.execPath, [path.join(root, 'node_modules/terse-cli/dist/index.js'), 'deploy'], {
    cwd: staging,
    env: process.env,
    stdio: 'inherit',
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  await rm(staging, { recursive: true, force: true })
}
