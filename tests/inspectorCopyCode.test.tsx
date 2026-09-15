// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Inspector } from '../src/components/Inspector.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import type { Frame } from '../shared/types.ts'

/**
 * https://github.com/kgoedecke/doop/issues/113 — getting a frame's HTML out
 * of the export panel meant clicking into the read-only textarea, scrolling,
 * and selecting all the text by hand. Every other export action (PNG, JPG,
 * Copy image URL) is a single click; "Copy code" should be too.
 */

const frame: Frame = {
  id: 'frame-1',
  canvasId: 'canvas-1',
  name: 'Landing hero',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html: '<!doctype html><html><body><h1>hello</h1></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'someone',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Inspector export row — Copy code', () => {
  it('copies the frame html to the clipboard in one click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(
      <TooltipProvider>
        <Inspector frame={frame} />
      </TooltipProvider>,
    )

    const copyButton = screen.getByRole('button', { name: 'Copy code' })
    fireEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith(frame.html)
    await waitFor(() => expect(screen.getByRole('button', { name: '✓ copied' })).toBeTruthy())
  })
})
