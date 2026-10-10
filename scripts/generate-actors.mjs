import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ActorCompiler } from 'durable-actors/compiler'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'generated/actors')

export async function generateActors(check = false) {
  const contract = new ActorCompiler().compileContract(path.join(root, 'src/actor.ts'))
  const publication = JSON.stringify({
    contract,
    contractHash: `sha256:${createHash('sha256').update(JSON.stringify(contract)).digest('hex')}`,
  })
  // Feed the official Terse generator the local source contract. No deployment,
  // credentials, or running actor service are needed to regenerate or check it.
  const server = createServer((_req, res) => res.setHeader('Content-Type', 'application/json').end(publication))
  const staging = await mkdtemp(path.join(tmpdir(), 'doop-codegen-'))
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const child = spawn(
      process.execPath,
      [path.join(root, 'node_modules/terse-cli/dist/index.js'), 'actor', 'generate', '--out-dir', staging],
      {
        cwd: root,
        env: {
          ...process.env,
          TERSE_ACTOR_URL: `http://127.0.0.1:${server.address().port}/v1/projects/local/actors`,
          TERSE_API_KEY: '',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    if (code !== 0) throw new Error('Actor generation failed')
    const files = await readdir(staging)
    const existing = await readdir(output).catch(() => [])
    if (existing.some((name) => !files.includes(name))) throw new Error('Unexpected files in generated/actors')
    if (!check) await mkdir(output, { recursive: true })
    for (const file of files) {
      const expected = await readFile(path.join(staging, file), 'utf8')
      const actual = await readFile(path.join(output, file), 'utf8').catch(() => undefined)
      if (expected === actual) continue
      if (check) throw new Error(`Stale generated actor client: ${file}. Run bun run actors:generate.`)
      await writeFile(path.join(output, file), expected)
    }
    console.log(`[actors] Generated client ${check ? 'is current' : 'updated'}.`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: generate-actors.mjs [--check]')
  await generateActors(process.argv.includes('--check'))
}
