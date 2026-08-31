# DESIGN - doop

Design tokens live in `src/styles.css` as CSS custom properties, mapped into Tailwind 4 via
`@theme`. shadcn is configured with style `radix-nova`, base color `neutral`, CSS variables on,
icon library `lucide` (`components.json`). Generate new shadcn components with the shadcn CLI
rather than hand-rolling primitives; it writes into `src/components/ui` per the aliases below.

## Palette

- `--paper` `#f7f7f9` / `--paper-deep` `#eeeef2` - page background layers.
- `--surface` `#ffffff` - card/panel surfaces.
- `--ink` `#17171b`, `--ink-soft`, `--ink-faint` - text, in descending emphasis.
- `--line`, `--line-soft` - borders/dividers.
- `--brand` `#e5533c` / `--accent-ink` `#c23a25` - the doop orange-red brand color and its ink
  variant.
- Full shadcn semantic set also present: `--primary`, `--secondary`, `--muted`, `--accent`,
  `--destructive`, `--border`, `--input`, `--ring`, `--card`, `--popover`, `--sidebar-*`,
  `--chart-1` through `--chart-5`.

## Typography

- `--font-ui`: `'Archivo', sans-serif` - UI text (`--font-sans` alias).
- `--font-display`: `'Bricolage Grotesque', sans-serif` - headings (`--font-heading` alias).
- `--font-mono`: `'Spline Sans Mono', ui-monospace, monospace`.

## Shape and depth

- `--radius`: `0.625rem`, with `--radius-sm` through `--radius-4xl` derived from it
  (`calc(var(--radius) * N)`) - use the scale, not one-off radius values.
- `--shadow-card` / `--shadow-pop` - two-layer soft shadows (ambient + key) for cards and popped
  elements respectively.

## Aliases (`components.json`)

- `@/components` -> `src/components`, `@/components/ui` -> `src/components/ui`,
  `@/lib` -> `src/lib`, `@/hooks` -> `src/hooks`, `@/lib/utils` -> `src/lib/utils`.

## Breakpoints

- `--breakpoint-xs`: `30rem`, `--breakpoint-md`: `56.25rem` - custom additions on top of
  Tailwind's defaults.
