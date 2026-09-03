import { expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4981

it('persists a complete canvas duplicate across a server restart', async () => {
  let server: Server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  try {
    const owner = new Client(server)
    await owner.signUp('duplicate@test.dev', 'Duplicate Owner')

    const source = await (await owner.post('/api/canvases', { name: 'Persistent design' })).json()
    const sourceFrame = await (await owner.post(`/api/canvases/${source.id}/frames`, { name: 'Image frame' })).json()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const upload = await owner.req(`/api/canvases/${source.id}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    })
    const asset = await upload.json()
    expect(upload.status, JSON.stringify(asset)).toBe(200)
    expect(
      (
        await owner.patch(`/api/frames/${sourceFrame.id}`, {
          html: `<img src="${asset.url}" alt="persistent duplicate">`,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await owner.req(`/api/canvases/${source.id}/guidelines/brand`, {
          method: 'PUT',
          body: JSON.stringify({ markdown: 'Use the brand blue.', title: 'Brand' }),
        })
      ).status,
    ).toBe(200)
    const sourceReference = await (
      await owner.post(`/api/canvases/${source.id}/references`, { frameId: sourceFrame.id })
    ).json()

    const duplicateResponse = await owner.post(`/api/canvases/${source.id}/duplicate`)
    const duplicate = await duplicateResponse.json()
    expect(duplicateResponse.status, JSON.stringify(duplicate)).toBe(200)

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer(PORT + 1, { BETTER_AUTH_URL: `http://localhost:${PORT + 1}` }, dataDir)

    const signedIn = new Client(server)
    expect(
      (
        await signedIn.post('/api/auth/sign-in/email', {
          email: 'duplicate@test.dev',
          password: 'password12345',
        })
      ).status,
    ).toBe(200)
    const response = await signedIn.get(`/api/canvases/${duplicate.id}`)
    const restored = await response.json()
    expect(response.status, JSON.stringify(restored)).toBe(200)
    expect(restored.linkAccess).toBeUndefined()
    expect(restored.memberIds).toBeUndefined()
    expect(restored.frames).toHaveLength(1)
    expect(restored.frames[0].id).not.toBe(sourceFrame.id)
    expect(restored.guidelines).toMatchObject([{ name: 'brand', markdown: 'Use the brand blue.', title: 'Brand' }])
    expect(restored.references).toHaveLength(1)
    expect(restored.references[0].id).not.toBe(sourceReference.id)
    expect(restored.references[0].frameId).toBe(restored.frames[0].id)

    const assetPath = new URL(restored.frames[0].html.match(/src="([^"]+)"/)![1]).pathname
    const copiedAsset = await fetch(`${server.base}${assetPath}`)
    expect(copiedAsset.status).toBe(200)
    expect(copiedAsset.headers.get('content-type')).toBe('image/png')
  } finally {
    server.stop()
  }
}, 70_000)
