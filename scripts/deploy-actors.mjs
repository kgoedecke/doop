import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { generateActors } from './generate-actors.mjs'

await generateActors(true)

// Package only the actors' source dependencies: never app data or local secrets.
const root = fileURLToPath(new URL('../', import.meta.url))
const config = path.resolve(process.argv[2] || path.join(root, 'terse.config.json'))
const projectConfig = await readFile(config, 'utf8')
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const parsed = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
const { options } = ts.parseJsonConfigFileContent(parsed.config, ts.sys, root)
const program = ts.createProgram([path.join(root, 'src/actor.ts')], options)
const staging = await mkdtemp(path.join(tmpdir(), 'doop-deploy-'))
try {
  const packages = new Set()
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || program.isSourceFileFromExternalLibrary(source)) continue
    const relative = path.relative(root, source.fileName)
    if (relative.startsWith('..')) throw new Error(`Actor source is outside the project: ${relative}`)
    const target = path.join(staging, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source.fileName, target)
    for (const { fileName } of ts.preProcessFile(source.text).importedFiles) {
      if (fileName.startsWith('.') || fileName.startsWith('node:')) continue
      packages.add(
        fileName
          .split('/')
          .slice(0, fileName.startsWith('@') ? 2 : 1)
          .join('/'),
      )
    }
  }
  const dependencies = Object.fromEntries([...packages].map((name) => [name, manifest.dependencies[name]]))
  await writeFile(
    path.join(staging, 'package.json'),
    JSON.stringify(
      {
        name: 'doop-actors',
        private: true,
        type: 'module',
        dependencies,
        devDependencies: {
          typescript: manifest.devDependencies.typescript,
          '@types/node': manifest.devDependencies['@types/node'],
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    path.join(staging, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: { ...parsed.config.compilerOptions, types: ['node'], paths: undefined },
        include: ['src', 'server', 'shared'],
      },
      null,
      2,
    ),
  )
  await writeFile(path.join(staging, 'terse.config.json'), projectConfig)
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
