/** Brand icons for well-known agents; the Doop mark otherwise. The marks
 *  themselves come from the BrandMark registry — this only knows which agent
 *  wears which brand. */

import { agentBrandOf, type AgentBrand } from '../../shared/agentBrand'
import { useStore } from '../lib/store'
import { AppIcon, BrandMark, type AppIconBrand } from './ui/brand-mark'
import { DoopMark, Logo } from './Logo'

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

/* the agent brands that have an app icon of their own; the rest sit on a plain tile */
const AGENT_APP_ICONS: Partial<Record<AgentBrand, AppIconBrand>> = {
  claude: 'claude',
  openai: 'openai',
  cursor: 'cursor',
  gemini: 'gemini',
  github: 'github',
  kimi: 'kimi',
}

/** An agent as an app icon: its brand's own tile and colours (Claude's orange,
 *  ChatGPT's knot on white), Doop's black tile for a Doop agent, and the brand
 *  mark on a plain tile for a client without an icon of its own. */
export function AgentTile({ name, brand, size = 18 }: { name: string; brand?: AgentBrand; size?: number }) {
  const shown = brand ?? agentBrandOf(name)
  if (!shown)
    return (
      <span aria-hidden className="flex-none" style={{ width: size, height: size }}>
        <Logo className="block size-full" />
      </span>
    )
  const app = AGENT_APP_ICONS[shown]
  if (app) return <AppIcon brand={app} size={size} />
  return (
    <span
      aria-hidden
      className="grid flex-none place-items-center bg-white shadow-ring"
      style={{ width: size, height: size, borderRadius: '23%' }}
    >
      <BrandMark brand={shown} size={Math.round(size * 0.56)} color="#111" />
    </span>
  )
}
