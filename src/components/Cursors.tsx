import { memo } from 'react'
import { useStore } from '../lib/store'
import { getIdentity } from '../lib/identity'
import { AgentIcon } from './AgentIcon'

/* Counter-scaling comes from the `--zoom` CSS variable (see .remote-cursor),
   so viewport changes never re-render this component. */
export const Cursors = memo(function Cursors() {
  const cursors = useStore((s) => s.cursors)
  const presences = useStore((s) => s.presences)
  const activePageId = useStore((s) => s.activePageId)
  const me = getIdentity().clientId

  return (
    <>
      {Object.entries(cursors).map(([clientId, pos]) => {
        if (clientId === me) return null
        const p = presences[clientId]
        if (!p || (p.viewport?.pageId && p.viewport.pageId !== activePageId)) return null
        return (
          <div
            key={clientId}
            className="pointer-events-none absolute z-30 origin-top-left [transition:transform_0.06s_linear]"
            style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(calc(1 / var(--zoom, 1)))` }}
          >
            <svg width="18" height="20" viewBox="0 0 18 20">
              <path
                d="M1 1 L16 8.5 L9 10.5 L6.5 18 Z"
                fill={p.color}
                stroke="#fff"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="absolute left-3.5 top-4 whitespace-nowrap rounded-[999px_999px_999px_4px] px-2 py-[3px] text-[11px] font-bold text-white"
              style={{ background: p.color }}
            >
              {p.kind === 'agent' && (
                <>
                  <AgentIcon name={p.name} size={9} color="#fff" />{' '}
                </>
              )}
              {p.name}
            </span>
          </div>
        )
      })}
    </>
  )
})
