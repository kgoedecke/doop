/* Zips chatgpt-plugin/ (plugin.json, mcp.json, assets/) into chatgpt-plugin/dist/doop.zip,
   the package the OpenAI Platform dashboard accepts. Validates the limits the
   dashboard enforces so a bad field fails here, not after the upload. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'chatgpt-plugin')
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'))
const ui = manifest.extensions['com.openai'].interface
const review = manifest.extensions['com.openai'].review

const limits = [
  ['displayName', ui.displayName, 30],
  ['shortDescription', ui.shortDescription, 30],
  ['longDescription', ui.longDescription, 4000],
  ['developerName', ui.developerName, 80],
  ['name', manifest.name, 64],
  ['description', manifest.description, 4000],
  ...['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'].map((k) => [k, ui[k], 1024]),
  ...ui.defaultPrompt.map((p, i) => [`defaultPrompt[${i}]`, p, 128]),
]
const problems = limits.filter(([, v, max]) => typeof v !== 'string' || !v.length || v.length > max)
if (ui.defaultPrompt.length > 3) problems.push(['defaultPrompt', 'count', 3])
if (review.test_cases.positive.length !== 5) problems.push(['test_cases.positive', 'count', 5])
if (review.test_cases.negative.length !== 3) problems.push(['test_cases.negative', 'count', 3])
for (const p of ['logo', 'composerIcon']) if (!existsSync(join(root, ui[p]))) problems.push([p, 'missing file', ''])
if (problems.length) {
  for (const [k, v, max] of problems) console.error(`✗ ${k}: ${typeof v === 'string' ? v.length : v} (limit ${max})`)
  process.exit(1)
}
if (!/^https:\/\//.test(review.demo_recording_url)) {
  console.warn('⚠ review.demo_recording_url is still a placeholder — replace it before submitting for review')
}

const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist)
const out = join(dist, 'doop.zip')
execFileSync('zip', ['-r', '-X', out, 'plugin.json', 'mcp.json', 'assets'], { cwd: root, stdio: 'inherit' })
console.log(`✓ ${out}`)
