/** Brand icons for well-known agents; the Doop mark otherwise. The marks
 *  themselves come from the BrandMark registry — this only knows which agent
 *  name wears which brand. */

import { BrandMark, type Brand } from './ui/brand-mark'
import { DoopMark } from './Logo'

/** the brand an agent name reads as, or none for a Doop agent */
export function agentBrandOf(name: string): Extract<Brand, 'claude' | 'openai' | 'cursor'> | undefined {
  const n = name.toLowerCase()
  if (n.includes('claude')) return 'claude'
  if (n.includes('codex') || n.includes('gpt')) return 'openai'
  if (n.includes('cursor')) return 'cursor'
  return undefined
}

export function AgentIcon({ name, size = 13, color }: { name: string; size?: number; color?: string }) {
  const brand = agentBrandOf(name)
  /* Anything else is a Doop agent (the built-in roles, or an unknown MCP
     client) and wears the brand's own mark, as on the marketing site. */
  if (!brand) return <DoopMark size={size} color={color} />
  return <BrandMark brand={brand} size={size} color={color} className="mr-px inline-block align-[-2px]" />
}
