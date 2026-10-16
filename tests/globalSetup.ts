import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { buildTemplate } from './harness.ts'

/* Runs once per vitest invocation, before any worker: the migrated PGlite
   template every integration server is copied from. Its own temp directory,
   so overlapping runs in one checkout never see each other's files. */
let dir: string

export async function setup(project: TestProject): Promise<void> {
  dir = mkdtempSync(path.join(tmpdir(), 'doop-test-template-'))
  await buildTemplate(dir)
  project.provide('templateDir', dir)
}

export function teardown(): void {
  rmSync(dir, { recursive: true, force: true })
}
