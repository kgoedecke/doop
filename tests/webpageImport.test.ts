import { describe, expect, it, vi } from 'vitest'
import type { Actor, Frame } from '../shared/types.ts'
import { createImportedWebpageFrame, findImportedWebpageFrame } from '../server/webpageImport.ts'

describe('agent webpage import', () => {
  it('finds an existing snapshot by its normalized requested URL', () => {
    const html =
      '<!doctype html><html><head><meta name="doop-import-source" content="https%3A%2F%2Fexample.com%2F"></head></html>'
    const frame = { id: 'source-1', html } as Frame

    expect(findImportedWebpageFrame([frame], 'example.com')).toBe(frame)
    expect(findImportedWebpageFrame([frame], 'other.example')).toBeUndefined()
  })

  it('maps the editable snapshot into the same attributed frame for every agent surface', async () => {
    const actor: Actor = { name: 'Test Agent', kind: 'agent', color: '#123456', owner: 'Test Owner' }
    const imported = {
      title: 'A very long imported webpage title '.repeat(4),
      width: 1280,
      height: 2048,
      html: '<!doctype html><html><body>Editable source</body></html>',
    }
    const frame: Frame = {
      id: 'frame-1',
      canvasId: 'canvas-1',
      name: imported.title.slice(0, 80),
      x: 10,
      y: 20,
      width: imported.width,
      height: imported.height,
      html: imported.html,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: actor.name,
    }
    const importPage: typeof import('../server/importer.ts').importPage = vi.fn(async () => imported)
    const createFrame: typeof import('../server/actions.ts').createFrame = vi.fn(async () => frame)

    const result = await createImportedWebpageFrame(
      { canvasId: 'canvas-1', url: 'example.com', actor, includePreview: true },
      { importPage, createFrame },
    )

    expect(importPage).toHaveBeenCalledWith('example.com', { includePreview: true })
    expect(createFrame).toHaveBeenCalledWith(
      'canvas-1',
      {
        name: imported.title.slice(0, 80),
        width: 1280,
        height: 2048,
        html: imported.html,
      },
      actor,
    )
    expect(result).toEqual({ imported, frame })
  })
})
