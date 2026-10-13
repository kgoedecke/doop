import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildAppArtifacts } from '@cantelop/sdk/build'

test('SDK compiles matching protocol Edge, native runtime and backend without shipping native code to Doop', async (t) => {
  const outdir = await mkdtemp(join(tmpdir(), 'doop-sdk-build-'))
  t.after(() => rm(outdir, { recursive: true, force: true }))
  const projectRoot = fileURLToPath(new URL('../', import.meta.url))
  const result = await buildAppArtifacts({ definition: join(projectRoot, 'src/cantelop.ts'), outdir, projectRoot })
  const app = result.apps[0]!
  assert.equal(app.name, 'doop-claude-runtime')
  assert.equal(app.runtime.manifest.cli_build_protocol_version, 6)
  assert.equal(app.runtime.manifest.integration_protocol_version, 2)
  assert.equal(app.runtime.manifest.capabilities.authTerminal, true)
  assert.equal(app.edge.manifest.auth, true)
  assert.equal(app.edge.manifest.session_runtime_id, app.runtime.manifest.session_runtime_id)
  assert.equal(result.backend.manifest.apps[0]!.session_runtime_id, app.runtime.manifest.session_runtime_id)
  assert.match(app.runtime.manifest.dockerfile!, /harnesses\/claude\/Dockerfile$/)
  const backend = await readFile(result.backend.mainModule, 'utf8')
  assert.ok(!backend.includes('node:child_process'))
  assert.ok(!/from ["']@cantelop\/sdk\/harnesses\/claude["']/.test(backend))
  assert.ok(!backend.includes('StateStore'))
})
