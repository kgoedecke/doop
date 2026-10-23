import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { buildTemplate } from './harness.ts'

/* Runs once per vitest invocation, before any worker: the migrated PGlite
   template every integration server is copied from. Its own temp directory,
   so overlapping runs in one checkout never see each other's files. */
let dir: string
// Synthetic provider catalogs: integration tests must never send fake keys to providers.
const catalogs = createServer((req, res) => {
  const path = new URL(req.url!, 'http://localhost').pathname
  const ids =
    path === '/anthropic'
      ? ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']
      : ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']
  const body =
    path === '/gemini'
      ? {
          models: ['gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-3.8-flash'].map((id) => ({
            name: `models/${id}`,
            displayName: id,
            supportedGenerationMethods: ['generateContent'],
            outputTokenLimit: 65536,
          })),
        }
      : {
          data: ids.map((id) => ({
            id,
            display_name: id,
            created: 1,
            max_tokens: 64000,
            capabilities: { image_input: { supported: true } },
          })),
          has_more: false,
        }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
})

export async function setup(project: TestProject): Promise<void> {
  dir = mkdtempSync(path.join(tmpdir(), 'doop-test-template-'))
  await buildTemplate(dir)
  project.provide('templateDir', dir)
  await new Promise<void>((resolve) => catalogs.listen(0, '127.0.0.1', resolve))
  const address = catalogs.address()
  if (!address || typeof address === 'string') throw new Error('Catalog fixture did not bind')
  project.provide('modelCatalogUrl', `http://127.0.0.1:${address.port}`)
}

export async function teardown(): Promise<void> {
  await new Promise<void>((resolve) => catalogs.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
}
