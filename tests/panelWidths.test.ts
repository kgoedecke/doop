import { describe, expect, it } from 'vitest'
import { AGENTS_MIN, LAYERS_MIN, fitPanelWidths } from '../src/lib/panelWidths'

/* the chrome left at 1000px with the Inspector open: tool rail, islands, gaps */
const reserved = 82 + 326

describe('fitPanelWidths', () => {
  it('keeps both open panels and the fixed chrome inside the window', () => {
    const fit = fitPanelWidths({
      saved: { layers: 350, agents: 350 },
      viewport: 1000,
      reserved,
      layersOpen: true,
      agentsOpen: true,
    })
    expect(fit.layers + fit.agents).toBeLessThanOrEqual(1000 - reserved)
    expect(fit.layers).toBeGreaterThanOrEqual(LAYERS_MIN)
    expect(fit.agents).toBeGreaterThanOrEqual(AGENTS_MIN)
  })

  it('stops each resize handle where it would meet the other panel', () => {
    const fit = fitPanelWidths({
      saved: { layers: 260, agents: 320 },
      viewport: 1000,
      reserved,
      layersOpen: true,
      agentsOpen: true,
    })
    expect(fit.layersMax).toBe(1000 - reserved - fit.agents)
    expect(fit.agentsMax).toBe(1000 - reserved - fit.layers)
  })

  it('leaves saved widths alone when they fit', () => {
    expect(
      fitPanelWidths({
        saved: { layers: 300, agents: 320 },
        viewport: 1600,
        reserved,
        layersOpen: true,
        agentsOpen: true,
      }),
    ).toMatchObject({ layers: 300, agents: 320 })
  })

  it('lets a lone panel use the room a closed one would take', () => {
    const fit = fitPanelWidths({
      saved: { layers: 350, agents: 350 },
      viewport: 1000,
      reserved,
      layersOpen: true,
      agentsOpen: false,
    })
    expect(fit.layers).toBe(350)
    expect(fit.layersMax).toBe(350)
  })
})
