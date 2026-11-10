import { expect, it, vi } from 'vitest'
import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import sharp from 'sharp'
import { Client } from './harness'
import { startPrivateServer } from './privateServer'

it('real held disk reads retain all four materializer slots after the default thirty-second caller deadline', async () => {
  const fixture = await startPrivateServer()
  const pipes: { file: string; saved: string; writer?: Awaited<ReturnType<typeof open>> }[] = []
  try {
    const owner = await new Client(fixture.server).signUp('real-drain@test.dev', 'Disk drain')
    const canvas = await (await owner.post('/api/canvases', { name: 'Actual disk drain' })).json()
    const frame = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Drain',
        x: 0,
        y: 0,
        width: 16,
        height: 16,
        html: '<p>Drain</p>',
      })
    ).json()
    const urls: string[] = []
    for (let index = 0; index < 4; index++) {
      const image = await sharp({
        create: { width: 4, height: 4, channels: 4, background: { r: 10 + index, g: 90, b: 40, alpha: 1 } },
      })
        .png()
        .toBuffer()
      const response = await owner.req(`/api/canvases/${canvas.id}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: new Uint8Array(image),
      })
      expect(response.status).toBe(200)
      const url = (await response.json()).url as string
      urls.push(url)
      const file = path.join(fixture.server.dataDir, 'data', 'assets', path.basename(new URL(url).pathname))
      const saved = file + '.drain-original'
      await rename(file, saved)
      pipes.push({ file, saved })
      execFileSync('mkfifo', ['-m', '600', file])
    }
    const request = (source: string) =>
      owner.post(`/api/canvases/${canvas.id}/private-materialization`, {
        source,
        syntax: 'html',
        context: { kind: 'frame', id: frame.id },
      })
    const started = Date.now()
    const held = urls.map((url) => request(`<img src="${url}">`))
    // Opening each real FIFO writer proves the production disk reader began.
    // No bytes/EOF are supplied until all caller responses have expired.
    for (const pipe of pipes) {
      await vi.waitFor(
        async () => {
          pipe.writer = await open(pipe.file, constants.O_WRONLY | constants.O_NONBLOCK)
        },
        { timeout: 10_000, interval: 20 },
      )
    }
    const responses = await Promise.all(held)
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000)
    for (const response of responses) {
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'Private media preparation was cancelled or timed out.' })
    }
    // This competing request uses PG only, so blocked filesystem threads cannot
    // hide an incorrectly released permit behind another disk read.
    let settled = false
    const competitor = request('').then((response) => {
      settled = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(settled).toBe(false)
    await pipes[0]!.writer!.close()
    pipes[0]!.writer = undefined
    const fresh = await competitor
    expect(fresh.status).toBe(200)
    expect((await fresh.json()).costs).toEqual({ resources: [], references: 0, parserWork: 0, expandedBytes: 0 })
    // Repeated fresh claims must remain usable; drained stale readers can never
    // publish the missing file or consume the transferred slot again.
    expect((await request('')).status).toBe(200)
    expect((await request('')).status).toBe(200)
  } finally {
    for (const pipe of pipes) {
      // Unblock even a pending open on an early assertion/setup failure.
      const unblock = await open(pipe.file, constants.O_RDWR | constants.O_NONBLOCK).catch(() => undefined)
      await pipe.writer?.close().catch(() => {})
      await unblock?.close().catch(() => {})
      await rm(pipe.file, { force: true })
      await rename(pipe.saved, pipe.file)
    }
    await fixture.close()
  }
}, 60_000)
