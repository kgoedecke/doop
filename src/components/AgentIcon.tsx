/** Brand icons for well-known agents; the Doop mark otherwise. The marks
 *  themselves come from the BrandMark registry — this only knows which agent
 *  wears which brand. */

import { agentBrandOf, type AgentBrand } from '../../shared/agentBrand'
import { useStore } from '../lib/store'
import { BrandMark } from './ui/brand-mark'
import { DoopMark } from './Logo'

export function AgentIcon({
  name,
  brand,
  size = 13,
  color,
}: {
  name: string
  /** the brand its presence carries (read from its MCP client); unset, the
   *  presence of an agent by this name on the open canvas is asked, then the name */
  brand?: AgentBrand
  size?: number
  color?: string
}) {
  const present = useStore((s) => {
    if (brand) return undefined
    for (const p of Object.values(s.presences)) if (p.kind === 'agent' && p.name === name && p.brand) return p.brand
    return undefined
  })
  const shown = brand ?? present ?? agentBrandOf(name)
  /* Anything else is a Doop agent (the built-in roles, or an unknown MCP
     client) and wears the brand's own mark, as on the marketing site. */
  if (!shown) return <DoopMark size={size} color={color} />
  return <BrandMark brand={shown} size={size} color={color} className="mr-px inline-block align-[-2px]" />
}
