import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'cli-package')
for (const args of [['scripts/build-claude-extension.mjs'], ['node_modules/vite/bin/vite.js', 'build']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
rmSync(output, { recursive: true, force: true })
mkdirSync(output)
for (const directory of ['cli', 'server', 'shared', 'dist'])
  cpSync(path.join(root, directory), path.join(output, directory), { recursive: true })
cpSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'))
cpSync(path.join(root, 'docs/cli.md'), path.join(output, 'README.md'))
const source = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
writeFileSync(
  path.join(output, 'package.json'),
  JSON.stringify(
    {
      name: '@killzonegaming/doop-cli',
      version: `${source.version}-cli.0`,
      private: true,
      description: 'Private preview of the Doop local application CLI',
      type: 'module',
      license: 'AGPL-3.0',
      engines: { node: '>=22.19.0' },
      bin: { doop: 'cli/doop.mjs' },
      files: ['cli', 'server', 'shared', 'dist', 'LICENSE', 'README.md'],
      dependencies: source.dependencies,
    },
    null,
    2,
  ) + '\n',
)
console.log('CLI staged in cli-package. Run npm pack ./cli-package to create an installable tarball.')
