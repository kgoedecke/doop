import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { startBrowserRig, type BrowserRig } from './browser.ts'
import { buildTemplate } from './harness.ts'

/* Runs once per vitest invocation, before any worker: the migrated PGlite
   template every integration server is copied from (its own temp directory,
   so overlapping runs in one checkout never see each other's files), and the
   shared, warmed Chromium + fixture server the browser tests drive. */
let dir: string
let rig: BrowserRig | null = null

export async function setup(project: TestProject): Promise<void> {
  dir = mkdtempSync(path.join(tmpdir(), 'doop-test-template-'))
  const [, started] = await Promise.all([buildTemplate(dir), startBrowserRig()])
  rig = started
  project.provide('templateDir', dir)
  project.provide('browserRig', rig && { wsEndpoint: rig.wsEndpoint, fixtureOrigin: rig.fixtureOrigin })
}

export async function teardown(): Promise<void> {
  rmSync(dir, { recursive: true, force: true })
  await rig?.close()
}
