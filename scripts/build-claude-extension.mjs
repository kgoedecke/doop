/* Ship the pinned proxy and its runtime dependencies inside the MCPB: Claude's
   bundled Node runs it without npx, a terminal or an install-time download.
   Preserve the installed dependency layout, including nested version conflicts. */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const zip = new JSZip()
const date = new Date('2026-01-01T00:00:00Z')
const packed = new Set()

async function addFile(source, destination) {
  const info = await stat(source)
  zip.file(destination, await readFile(source), { date, unixPermissions: info.mode & 0o777 })
}

async function addDirectory(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    // Dependencies are visited separately; never sweep in unrelated packages.
    if (entry.name === 'node_modules' || entry.name === '.bin') continue
    const source = join(directory, entry.name)
    if (entry.isDirectory()) await addDirectory(source)
    else await addFile(source, relative(root, source).split(sep).join('/'))
  }
}

async function addPackage(name, parent) {
  // Walk Node's installed package locations, closest dependency first. Bun
  // treats undici as a built-in and returns null from require.resolve.paths,
  // but the archive still needs the real package for Claude's Node runtime.
  // Reading manifests directly also handles restrictive package exports.
  let directory
  for (let search = parent; ; search = dirname(search)) {
    if (basename(search) !== 'node_modules') {
      const candidate = join(search, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) {
        directory = candidate
        break
      }
    }
    if (search === root) break
  }
  if (!directory || !relative(root, directory).startsWith(`node_modules${sep}`)) {
    throw new Error(`Cannot package ${name}: install dependencies with bun install first`)
  }
  if (packed.has(directory)) return
  packed.add(directory)
  await addDirectory(directory)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) await addPackage(dependency, directory)
}

await addPackage('mcp-remote', root)
await addFile(join(root, 'claude-extension/manifest.json'), 'manifest.json')
await addFile(join(root, 'claude-extension/README.md'), 'README.md')
await addFile(join(root, 'public/logo.png'), 'icon.png')
await addFile(join(root, 'LICENSE'), 'LICENSE')

const output = join(root, 'public/claude-extension')
await mkdir(output, { recursive: true })
await writeFile(
  join(output, 'doop.mcpb'),
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }),
)
console.log(`Built public/claude-extension/doop.mcpb (${packed.size} bundled packages)`)
