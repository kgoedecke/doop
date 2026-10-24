/* The canvas page's two resizable panels share the window with the tool rail,
   the Inspector and the icon islands. Each panel is capped on its own (480px,
   35% of the window), and the open ones together never take more than what
   that fixed chrome leaves, so widening one can't push it under the other. */

export const LAYERS_MIN = 220
export const AGENTS_MIN = 260
const PANEL_MAX = 480
const PANEL_SHARE = 0.35

interface PanelFitInput {
  saved: { layers: number; agents: number }
  viewport: number
  /** the chrome's width with both panels at zero: rails, islands, Inspector, gaps */
  reserved: number
  layersOpen: boolean
  agentsOpen: boolean
}

export interface PanelFit {
  layers: number
  agents: number
  /** how far each panel's resize handle can go with the other as it is */
  layersMax: number
  agentsMax: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function fitPanelWidths({ saved, viewport, reserved, layersOpen, agentsOpen }: PanelFitInput): PanelFit {
  const cap = Math.min(PANEL_MAX, Math.floor(viewport * PANEL_SHARE))
  const budget = viewport - reserved
  let layers = clamp(saved.layers, LAYERS_MIN, Math.max(LAYERS_MIN, cap))
  let agents = clamp(saved.agents, AGENTS_MIN, Math.max(AGENTS_MIN, cap))
  const open = (layersOpen ? layers : 0) + (agentsOpen ? agents : 0)
  if (open > budget) {
    /* give back the overflow from each open panel's room above its minimum */
    const layersSlack = layersOpen ? layers - LAYERS_MIN : 0
    const agentsSlack = agentsOpen ? agents - AGENTS_MIN : 0
    const slack = layersSlack + agentsSlack
    const cut = Math.min(open - budget, slack)
    if (slack > 0) {
      layers -= Math.round((cut * layersSlack) / slack)
      agents -= cut - Math.round((cut * layersSlack) / slack)
    }
  }
  return {
    layers,
    agents,
    layersMax: clamp(budget - (agentsOpen ? agents : 0), LAYERS_MIN, Math.max(LAYERS_MIN, cap)),
    agentsMax: clamp(budget - (layersOpen ? layers : 0), AGENTS_MIN, Math.max(AGENTS_MIN, cap)),
  }
}
