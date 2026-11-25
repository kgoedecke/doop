import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/*
 * The doop CLI as an npm package (scripts/pack-doop-cli.mjs): what `npm publish` would send,
 * and that installing it puts a working `doop` on the PATH.
 */

const run = promisify(execFile)

interface Manifest {
  name: string
  repository: { url: string }
  version: string
  bin: Record<string, string>
  dependencies?: Record<string, string>
  engines: { node: string }
}

describe('the doop CLI package', () => {
  let manifest: Manifest

  beforeAll(async () => {
    await run('node', ['scripts/pack-doop-cli.mjs'])
    manifest = JSON.parse(readFileSync('cli/dist/package.json', 'utf8')) as Manifest
  }, 60_000)

  it('carries its own version and one dependency-free file', async () => {
    const own = JSON.parse(readFileSync('cli/package.json', 'utf8')) as { version: string }
    expect(manifest).toMatchObject({ name: '@doop-design/cli', version: own.version, bin: { doop: 'doop.mjs' } })
    expect(own.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.engines.node).toBe('>=20')
    /* npm's trusted publishing holds this against the repository of publish-cli.yml */
    expect(manifest.repository.url).toBe('git+https://github.com/doop-design/doop.git')

    const { stdout } = await run('npm', ['pack', '--dry-run', '--json'], { cwd: 'cli/dist' })
    const [packed] = JSON.parse(stdout) as [{ files: { path: string }[] }]
    const expected = ['README.md', 'doop.mjs', 'package.json', ...(existsSync('LICENSE') ? ['LICENSE'] : [])]
    expect(packed.files.map((file) => file.path).sort()).toEqual(expected.sort())
  })

  it('installs a `doop` command that runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doop-cli-npm-'))
    try {
      const { stdout: tarball } = await run('npm', ['pack', '--pack-destination', dir], { cwd: 'cli/dist' })
      await run('npm', ['install', '--global', '--prefix', join(dir, 'prefix'), join(dir, tarball.trim())])
      const doop = join(dir, 'prefix', 'bin', 'doop')
      expect((await run(doop, ['--version'])).stdout.trim()).toBe(manifest.version)
      expect((await run(doop, ['help'])).stdout).toContain('design on a Doop canvas from the shell')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
