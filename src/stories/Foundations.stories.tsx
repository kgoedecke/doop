import type { Meta, StoryObj } from '@storybook/react-vite'
import { cn } from '@/lib/utils'

/**
 * The tokens every component is built from, read live from the stylesheet
 * so a token change shows up here before anyone touches a component.
 */
const meta = { title: 'Foundations' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

const COLOURS: { token: string; cls: string; role: string }[] = [
  { token: '--paper', cls: 'bg-paper', role: 'the canvas and page ground' },
  { token: '--paper-deep', cls: 'bg-paper-deep', role: 'pressed or selected row fill' },
  { token: '--sub', cls: 'bg-sub', role: 'filled wells: the rail, field backgrounds' },
  { token: '--surface', cls: 'bg-surface', role: 'cards, panels, menus' },
  { token: '--ink', cls: 'bg-ink', role: 'text, the primary button' },
  { token: '--ink-soft', cls: 'bg-ink-soft', role: 'secondary text, icons' },
  { token: '--ink-faint', cls: 'bg-ink-faint', role: 'captions, timestamps, counts' },
  { token: '--ink-ghost', cls: 'bg-ink-ghost', role: 'placeholders, unit letters' },
  { token: '--line', cls: 'bg-line', role: 'borders and dividers' },
  { token: '--line-soft', cls: 'bg-line-soft', role: 'the quieter divider' },
  { token: '--brand', cls: 'bg-brand', role: 'the one accent: selection, focus, live' },
  { token: '--accent-ink', cls: 'bg-accent-ink', role: 'failure' },
  { token: '--success', cls: 'bg-success', role: 'done, connected, live dot' },
  { token: '--warning', cls: 'bg-warning', role: 'needs attention' },
]

export const Colours: Story = {
  render: () => (
    <div className="grid max-w-[720px] grid-cols-1 gap-2 sm:grid-cols-2">
      {COLOURS.map((c) => (
        <div key={c.token} className="flex items-center gap-3 rounded-card bg-surface p-2.5 shadow-ring">
          <span className={cn('size-9 flex-none rounded-control shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]', c.cls)} />
          <span className="min-w-0">
            <span className="block font-mono text-label text-ink">{c.token}</span>
            <span className="block text-caption text-ink-faint">{c.role}</span>
          </span>
        </div>
      ))}
    </div>
  ),
}

const STEPS: { cls: string; px: string; role: string }[] = [
  { cls: 'text-display', px: '46', role: 'the home greeting' },
  { cls: 'text-title', px: '24', role: 'page titles' },
  { cls: 'text-heading', px: '18', role: 'card and modal headings' },
  { cls: 'text-lead', px: '15', role: 'ledes, the composer placeholder' },
  { cls: 'text-copy', px: '13.5', role: 'prose in cards and modals' },
  { cls: 'text-body', px: '12.5', role: 'the chrome: rows, buttons, chips, menus' },
  { cls: 'text-label', px: '12', role: 'chrome labels' },
  { cls: 'text-caption', px: '11', role: 'timestamps, counts, section labels' },
  { cls: 'text-micro', px: '10', role: 'mono captions, key caps, badges' },
]

const FACES = [
  {
    token: '--font-ui / --font-display',
    cls: 'font-sans',
    family: 'Inter',
    weights: '400 · 500 · 600',
    role: 'Everything the chrome says: labels, rows, buttons, headings. Display is the same face — the chrome is quiet by design.',
    sample: 'Ask me what to design, Kevin',
  },
  {
    token: '--font-mono',
    cls: 'font-mono',
    family: 'Geist Mono',
    weights: '400 · 500',
    role: 'Values only: ids, sizes, coordinates, key caps, code. Never a caption, never uppercase.',
    sample: '1440 × 900 · #0177d3 · ⌘K · 5BNZaqaASa',
  },
  {
    token: '--font-hero',
    cls: 'font-hero font-light tracking-[-0.02em]',
    family: 'Hanken Grotesk',
    weights: '300',
    role: 'The home greeting, and nothing else (`font-hero`). Loaded in index.html beside the others.',
    sample: 'Ask me what to design',
  },
] as const

/** The three faces the product is set in, and what each is allowed to say. Instrument Serif and the mono-uppercase caption voice are retired. */
export const Typefaces: Story = {
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-5">
      {FACES.map((f) => (
        <div key={f.token} className="flex flex-col gap-2 border-b border-line-soft pb-5">
          <span className={cn(f.cls, 'text-title text-ink')}>{f.sample}</span>
          <span className={cn(f.cls, 'text-copy text-ink-soft')}>
            The quick brown fox jumps over the lazy dog · 0123456789
          </span>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-ink-faint">
            <span className="font-mono">{f.token}</span>
            <span className="text-ink-soft">{f.family}</span>
            <span>{f.weights}</span>
          </div>
          <p className="max-w-[60ch] text-caption text-ink-faint">{f.role}</p>
        </div>
      ))}
      <p className="text-caption text-ink-faint">
        Retired: Instrument Serif (headlines now use the title step in Inter) and mono uppercase captions (now
        text-caption in sentence case).
      </p>
    </div>
  ),
}

export const TypeScale: Story = {
  name: 'Type scale',
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-4">
      {STEPS.map((s) => (
        <div key={s.cls} className="flex items-baseline gap-4 border-b border-line-soft pb-3">
          <span className="w-[120px] flex-none font-mono text-caption text-ink-faint">
            {s.cls}
            <br />
            {s.px}px
          </span>
          <span className={cn(s.cls, 'min-w-0 flex-1 truncate text-ink')}>Ask me what to design</span>
          <span className="hidden w-[220px] flex-none text-caption text-ink-faint sm:block">{s.role}</span>
        </div>
      ))}
      <p className="text-caption text-ink-faint">
        Weights: 400 for text, 500 for labels, buttons and emphasis, 600 for card and modal headings only.
      </p>
    </div>
  ),
}

const RADII = [
  ['rounded-row', '7px', 'list and rail rows'],
  ['rounded-control', '8px', 'buttons and fields'],
  ['rounded-pill', '10px', 'chips and pills'],
  ['rounded-card', '12px', 'cards and tiles'],
  ['rounded-panel', '14px', 'floating panels and modals'],
] as const

const SHADOWS = [
  ['shadow-ring', 'a resting control'],
  ['shadow-ring-hover', 'the control under the pointer'],
  ['shadow-float', 'a panel floating over the canvas'],
  ['shadow-pop', 'a menu or toast'],
] as const

export const ShapeAndDepth: Story = {
  name: 'Shape & depth',
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-8">
      <div className="flex flex-wrap gap-4">
        {RADII.map(([cls, px, role]) => (
          <div key={cls} className="flex flex-col items-center gap-2">
            <span className={cn('size-16 bg-surface shadow-ring', cls)} />
            <span className="font-mono text-caption text-ink">{cls}</span>
            <span className="text-caption text-ink-faint">
              {px} · {role}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-6">
        {SHADOWS.map(([cls, role]) => (
          <div key={cls} className="flex flex-col items-center gap-2">
            <span className={cn('h-16 w-24 rounded-card bg-surface', cls)} />
            <span className="font-mono text-caption text-ink">{cls}</span>
            <span className="text-caption text-ink-faint">{role}</span>
          </div>
        ))}
      </div>
    </div>
  ),
}
