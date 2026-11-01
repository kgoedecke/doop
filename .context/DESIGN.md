# DESIGN - doop

Design tokens live in `src/styles.css` as CSS custom properties, mapped into Tailwind 4 via
`@theme`. shadcn is configured with style `radix-nova`, base color `neutral`, CSS variables on,
icon library `lucide` (`components.json`). Generate new shadcn components with the shadcn CLI
rather than hand-rolling primitives; it writes into `src/components/ui` per the aliases below.

## Palette

White system (Doop UI v2, canvas guideline `doop-ui-system`): neutral greys, no warm cream.

- `--paper` `#fdfdfd` (canvas) / `--paper-deep` `#f0f0f0` (pressed or selected row fill) / `--sub`
  `#f7f7f7` (filled field wells) - background layers.
- `--surface` `#ffffff` - card/panel surfaces.
- `--ink` `#111`, `--ink-soft` `#5f5e5b`, `--ink-faint` `#9c9b99`, `--ink-ghost` `#b8b8b8` - text, in
  descending emphasis (ghost: placeholders, unit letters).
- `--line` `#dcdcdc`, `--line-soft` `#ececec` - borders/dividers.
- `--brand` `#0177d3` - the one accent: selection, focus, live signal. `--accent-ink` - failure red.
  The primary button is ink (black), not brand.
- `--code` `#17171b` / `--code-ink` `#e9e9ee` (`bg-code`, `text-code-ink`) - the dark code well of
  `CodeBlock` and the HTML editors; the same in both themes.
- `--glaze-ring` - the silver hairline an active agent wears in the presence pill.
- Full shadcn semantic set also present: `--primary`, `--secondary`, `--muted`, `--accent`,
  `--destructive`, `--border`, `--input`, `--ring`, `--card`, `--popover`, `--sidebar-*`,
  `--chart-1` through `--chart-5`.

## Typography

- `--font-ui` / `--font-display`: `'Inter'` - UI and headings (`--font-sans` / `--font-heading`
  aliases). `--font-mono`: `'Geist Mono', ui-monospace, monospace` - values only (ids, sizes,
  numbers, key caps, code); the mono-uppercase caption voice is retired, captions and field labels
  are `text-caption` / `text-label` in sentence case. `--font-hero`: `'Hanken Grotesk'` Light - the
  home greeting, and nothing else (loaded in `index.html`). There is no
  serif: Instrument Serif was retired, and page-level headings outside the dashboard (sign-in,
  not-found, the desktop handoff) use `DashTitle` like every other page title.
- **The scale** is named by role, as `--text-*` tokens in `src/styles.css` (each carries its line
  height, so one class sets both). Use these; `text-[Npx]` is for a one-off the scale cannot name,
  and the canvas editor's chrome is still being moved over.

  | class          | size   | used for                                                    |
  | -------------- | ------ | ----------------------------------------------------------- |
  | `text-micro`   | 10px   | mono captions, key caps, badges                             |
  | `text-caption` | 11px   | timestamps, counts, section labels, the line under a row    |
  | `text-label`   | 12px   | chrome labels                                               |
  | `text-body`    | 12.5px | the chrome's voice: rail rows, buttons, chips, menus, lists |
  | `text-copy`    | 13.5px | prose inside cards and modals                               |
  | `text-lead`    | 15px   | a modal's lede, the composer's placeholder                  |
  | `text-heading` | 18px   | card and modal headings                                     |
  | `text-title`   | 24px   | page titles (`DashTitle`)                                   |
  | `text-display` | 46px   | the home greeting                                           |

- **Weights**: 400 for text, 500 for labels, buttons and emphasis. 600 is for card and modal
  headings only; nothing in the chrome goes heavier.
- Icons: Lucide via `src/components/ui/icons.tsx`, 1.15 stroke (`ICON_STROKE`), and nowhere else:
  screens import the glyph from there rather than wrapping or inlining one. Sizes come from
  `ICON_SIZE` through the `size` prop: `size="rail"` (14px) beside rail rows, menu items, tabs and
  the editor chrome, the 16px default (`button`) inside buttons; a pixel count for a one-off. One
  glyph per destination: Community is `WebIcon`, Automations `WorkflowIcon`, Integrations
  `BlocksIcon`.

## Shape and depth

- `--radius`: `0.5rem`, with `--radius-sm` through `--radius-4xl` derived from it
  (`calc(var(--radius) * N)`). The shapes the system actually draws have names: `rounded-tag`
  (4px, badges and checkbox squares), `rounded-row` (7px, list and rail rows), `rounded-control`
  (8px, buttons and fields), `rounded-pill` (10px, chips and pills), `rounded-card` (12px, cards
  and tiles), `rounded-panel` (14px, floating panels and modals). Reach for these before a
  `rounded-[Npx]`.
- No borders on controls: `--shadow-ring` (`shadow-ring`, 1px ring + soft drop) for inputs, chips and
  pills, `--shadow-ring-hover` on hover, `--shadow-float` (`shadow-float`) for panels floating over
  the canvas, `--shadow-pop` for menus and toasts. `--shadow-card` / `--shadow-elevation-*` alias
  these.

## Theme

- Light is the default; `.dark` on `<html>` switches every token above. The shadcn semantic set
  resolves through `--paper` / `--ink`, so `.dark` redefines only the primitives and shadows.
- The preference (`light` / `dark` / `system`) lives in `localStorage` under `doop-theme`, per
  browser. `index.html` paints it before the bundle loads; `src/lib/theme.ts` owns it after that
  (`initTheme()` in `main.tsx`, `useTheme()` in components). Controls: Settings -> Appearance and
  the account menu.
- `--success` / `--success-ink` and `--warning` / `--warning-ink` are the status colours; use
  them (`bg-success`, `text-success-ink`) rather than literal greens. Text on an ink fill is
  `text-paper`, never `text-white`, so it flips with the theme. `text-white` is for brand and
  accent fills and for dark overlays, which stay dark in both themes.

## Component catalogue (Storybook)

- `bun run storybook` serves the catalogue on :6006; `bun run build-storybook` writes
  `storybook-static/`. Config in `.storybook/`, stories in `src/stories/` (CSF3, `*.stories.tsx`).
  It rides on the app's own `vite.config.ts`, so Tailwind, the `@` alias and the fonts need no second
  setup, and the toolbar's theme switch flips `.dark` the way `src/lib/theme.ts` does.
- Foundations (colours, the type scale, radii, shadows, every icon) render from the live tokens;
  Primitives cover `src/components/ui`; Marks is the one page every logo and avatar comes from;
  Shell shows the rail and the search palette with sample data. A new primitive is not done until it
  has a story, and a new screen starts from this catalogue rather than from a blank file.

## Component index (`src/components/ui`)

Screens compose these; they do not draw their own buttons, fields, sizes, weights or colours (an
ESLint `no-restricted-syntax` rule in `eslint.config.js` holds `src/pages/**`, `src/components/**`
and `src/integrations/**` to it, banning raw elements and `role="button"` divs, arbitrary and
stock Tailwind type sizes and radii, `leading-[…]` / `tracking-[…]`, weights past `font-semibold`
and hex colours; only the not-yet-migrated editor chrome, listed in `LEGACY_CHROME`, is exempt).
Each has a story.

- `Button` - the ring button, one black `primary` per screen (`size="bar"` is the 32px header
  and toolbar action with a leading glyph: Import, New canvas; `size="inline"` is a boxless text
  action at the caption step, `bare` in a selection bar, `link` in a card or callout);
  `IconButton` - a glyph in a quiet square (sm 24px / md 32px / lg 34px, `round` for row actions,
  `on` keeps the paper-deep fill, `aria-label` required; `variant="primary"` is the ink send
  button, `frosted` the chip over a preview image, `danger` a row's remove ✕, and
  `frostedSurface` is that chip's surface for static marks beside it); `Pressable` - the
  chrome-less button a card tile, list row or inline text action is made of (focus ring only);
  `MenuButton` - a dropdown trigger with a trailing chevron (`ring` in a header, `quiet` inside a
  composer); `Chip` - the 32px suggestion pill with an 18px icon tile
  (`ChipIcon`), faded until hovered, focused or `on`; `ToggleChip` - the chosen-one-of-many pills
  (`ToggleChipItem size="sm"` for the compact shelf filters).
- `Input` / `Textarea` / `Field` / `Checkbox` / `Segmented` - form controls (`variant="well"`
  is the filled field of a modal or form: paper inside a hairline, no focus glow;
  `Textarea variant="code"` is the dark HTML editor); `Switch` - an on/off that applies at once
  (brand track, `size` sm 26x16 / md 34x20); `Select` - one value from a short list
  (`SelectTrigger` `size` sm 32px / md 36px, a ring control like `Input`; `value=""` shows the
  placeholder and no `SelectItem` may use the empty string, so a real "none" needs a sentinel);
  `SearchField` - the leading-glyph search
  (`ring` 30px pill, `bar` the palette's 48px top line; `size="header"` puts the ring on its own
  40px row on a phone and caps it at 320px from md) wrapping a bare Input, with a `trailing` slot
  for a `Kbd`; `Kbd` - a 20px key cap in mono micro type with an inset hairline.
- `Card` (`tone` default/flat/raised/dashed, `shape` hero for the 18px empty-state corner),
  `SettingsCard` - one section of a settings pane (Settings, Workspace): a `Card` at the 1000px
  settings width with the section spacing, any `tone`; `CardRow` - its labelled row, whose
  `control` slot holds the field at one width (`controlWidth` md 280px, lg 420px) so a card's
  fields line up, full width on phones; `EmptyState` (`card` hero on a list page, `dashed` with an `illustration` row on a table page:
  title, description, one `action`), `Tile` (the cover-and-meta grid tile on Home, Community and
  Admin: `tone` frosted/solid, `TileCover aspect="5/3|16/10|4/3"` the dotted well, `TileBody`,
  and `MetaLine`, which joins its parts with the quiet `·` and takes a separator-free `trailing`
  badge), `Callout`, `Note`, `Badge` (`tone` default/accent/outline/
  admin/banned, `brand` for the one highlighted option, `success` for a confirmed state; `shape`
  `pill` is the truncating source tag in a review header), `Dot`, `StatusLabel` (a `Dot` plus
  caption, `tone` done/muted: the "connected / not connected" line), `Progress`, `Skeleton` (`shape="tile"` takes the
  Tile's `aspect` and matches its footprint, `row` a 56px list row, `card` a 150px card),
  `CodeBlock`, `List` (`PersonRow` is one person on a line: `avatar`, `name`, `detail`,
  `trailing`), `SelectionBar` (`count`, `total`, `actions` of `SelectionBarAction`s: the "N of M
  selected · Clear" line over a checklist), `Steps` / `Step` (a numbered how-to, numbered by a CSS
  counter), `Tabs` (`TabsList variant="card"` is the phone's full-width pane
  switcher), `Dash*` (the dashboard frame; on a phone `DashHeader` draws the
  brand row itself, a rail toggle plus wordmark, whenever an `AppRail` is mounted, and the rail
  opens as a left drawer that closes on any pick) - surfaces and content. The rail is built from
  the same parts: `DashSidebar variant="rail"` (borderless, `bg-sub`, 236px), `DashSidebarBrand`
  (the Disc-D home button, with the rail's own controls as children), `DashSectionLabel
density="rail"` (the group caption with its chevron) and `DashNavItem density="rail"` (the 31px
  row; `as="div"` for a static row such as an agent, `count` for a mono number, `trailing` for
  anything else). `DashHeader variant="bare"` drops the fill and the rule on the rail pages.
  Home, Automations, Integrations, Community, Workspace and Admin all mount `AppRail`, passing
  their own group as children; Settings draws its own rail from the same parts.
  `src/components/FramePreview.tsx` is the one frame-image-with-fallbacks (empty / failed, failure
  keyed per frame id) every thumbnail, card cover and gallery figure renders through. Its
  `FrameThumb` is the boxed well a row or menu item leads with (`rounded-row`, `shadow-ring`,
  paper-deep fill): `size` xs 34x22 (table rows, menu items), sm 64x40 (list rows, the search
  palette, the export checklist), md 96px tall at its column's width (frame strips).
- `Modal`, `Sheet`, `AlertDialog`, `DropdownMenu`, `ContextMenu`, `Tooltip`, `Toast` - overlays.
  A dropdown is one menu everywhere: `DropdownMenuContent width="sm|md|lg"` (160 / 220 / 260px;
  unset is the 340px reading width) instead of a `w-[…]` or a re-skin, `DropdownMenuCaption` over a
  group, `DropdownMenuRadioGroup` / `DropdownMenuRadioItem` for pick-one rows (the check is drawn
  for you), and `description` on an item or radio item for the caption sub-line under its label.
  `Disclosure` (`collapsible.tsx`) - the fold-away aside in place of a `<details>`: a label with a
  turning chevron, the body kept mounted while folded.
- `AuthScreen` + `AuthCard` (`screen.tsx`) - every signed-out screen (sign-in, OAuth consent, the
  desktop hand-offs, a missing canvas): the wordmark and a `DashTitle` on one card, with
  `AuthCardText` for its prose and `align="center"` for a centred card. `InstallBlock` - an agent's
  one-click install in Connect AI (Codex, Claude Desktop, Cursor): `action`, a `status` line, an
  `error`, and the `manual` steps in a `Disclosure`.
- `Avatar` - the one presence face: a disc on a 2px surface collar, any px `size` (24 in the
  presence pill, 18 on a canvas card, 28-32 in menus and rows); a person is initials on a 22% tint
  of their colour, an agent its brand mark on the surface, `glaze` for an agent at work, `stacked`
  to overlap, `children` replaces the initials. `PresenceFace` in `PeerAvatars.tsx` is the same
  component under the canvas chrome's name. `AvatarStack` (the first `max` people plus a "+N"
  disc), `tone="ink"` (the account's own face: initials on an ink disc, no collar), `initials()`
  (the one first-and-last-letter rule), `BrandMark` - every third-party logo (`<BrandMark brand="figma" size={16} />`; figma, github,
  canva, photoshop, meta, claude, openai, cursor, gemini, google, apple, microsoft, slack, linear),
  `Wordmark`, `Logo` / `DoopMark` (the bare Disc-D; `animated` hops its dot, as the home greeting
  wears it), `icons.tsx` - identity. Feature tiles (`FigmaTile`, `MetaTile`, the integrations'
  `Tile`s, `AgentIcon`) compose a `BrandMark`; nothing else inlines a logo path.
- Editor chrome (`PropertyField`, `Toolbar`, `Panel`, `Menu`) - the canvas page's own set, still on
  exact pixel sizes until its pass. `Panel` has three surfaces: `floating` (an island over the
  board), `docked` (a flush column with a hairline on its canvas side, the Appearance setting's
  docked layout) and `inline` (filling a phone sheet).
- Sizing a primitive: a named step (`text-body`) where the box height is fixed or a `leading-*` sits
  beside it; a step with a leading modifier (`text-body/4`) where the box came from padding plus the
  browser's default leading, so putting it on the scale did not grow it.

## Aliases (`components.json`)

- `@/components` -> `src/components`, `@/components/ui` -> `src/components/ui`,
  `@/lib` -> `src/lib`, `@/hooks` -> `src/hooks`, `@/lib/utils` -> `src/lib/utils`.

## Breakpoints

- `--breakpoint-xs`: `30rem`, `--breakpoint-md`: `56.25rem` - custom additions on top of
  Tailwind's defaults.
