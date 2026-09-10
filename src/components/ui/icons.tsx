import type { SVGProps } from 'react'

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

export function MoreHorizontalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ShareIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" />
    </svg>
  )
}

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <rect width="13" height="13" x="8" y="8" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </svg>
  )
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5" />
    </svg>
  )
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export function GithubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} fill="currentColor" stroke="none" {...props}>
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.25 10.25 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  )
}

export function SyncIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

/* arrow into a tray — the top bar's Import */
export function ImportIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} strokeWidth={1.9} {...props}>
      <path d="M12 3v11m0 0 4.5-4.5M12 14l-4.5-4.5M4 20h16" />
    </svg>
  )
}

/* heartbeat line — the activity feed */
export function PulseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} strokeWidth={1.8} {...props}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  )
}

/* four-point spark — the AI affordance */
export function SparkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} fill="currentColor" stroke="none" {...props}>
      <path d="M12 2.6 14.3 9l6.4 2.3-6.4 2.3L12 20l-2.3-6.4L3.3 11.3 9.7 9z" />
    </svg>
  )
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** Two chevrons pointing inward — collapse every open row. */
export function CollapseAllIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />
    </svg>
  )
}

/** Collapse a side rail: the panel outline with an arrow tucking into it. */
export function PanelCollapseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16M16 10l-2 2 2 2" />
    </svg>
  )
}

/** Expand a side rail: the same outline, arrow pointing out. */
export function PanelExpandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16m5-11 3 3-3 3" />
    </svg>
  )
}

/** The stacked-sheets glyph the Layers rail wears when collapsed. */
export function LayersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" />
    </svg>
  )
}

/** A frame row's mark: the artboard hash. */
export function FrameIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </svg>
  )
}

export function BoxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}

export function TextIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M5 6h14M12 6v13" />
    </svg>
  )
}

export function ImageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="m4 16 5-5 4 4 3-3 4 4" />
    </svg>
  )
}

export function VectorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M5 19c0-8 4-14 14-14M5 19h3M5 19v-3M19 5h-3M19 5v3" />
    </svg>
  )
}

/* a window with its right pane marked out — the side-panel toggle */
/** Mirror of PanelCollapseIcon for a panel docked on the right. */
export function PanelCollapseRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4v16M8 10l2 2-2 2" />
    </svg>
  )
}

/** Mirror of PanelExpandIcon for a panel docked on the right. */
export function PanelExpandRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4v16m-5-11-3 3 3 3" />
    </svg>
  )
}

/* ribbon bookmark — the canvas memory */
export function BookmarkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} strokeWidth={1.8} {...props}>
      <path d="M6 4h12v17l-6-4-6 4z" />
    </svg>
  )
}

export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ArrowUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M12 19V5m0 0-6 6m6-6 6 6" />
    </svg>
  )
}
