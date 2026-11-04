# Design tokens and themes

A canvas carries typed design tokens: its named colours, spacing, radii and type, each a CSS
custom property a frame uses by writing `var(--name)`. Tokens follow Paper's vocabulary (eleven
types in three groups), so an agent that knows Paper's `create_tokens` / `set_tokens` /
`get_tokens` calls ours with the same payload, and names follow Tailwind v4's `@theme`
namespaces so the Tailwind export is a rename-free pass-through. Themes (light, dark, compact…)
give a token a second value, as in Pen's themes and Figma's variable themes. GitHub issue #345.

## Model (`shared/designTokens.ts`)

- `DesignToken { name, type, value, themes?, description?, order, updatedAt, updatedBy }`.
  `name` matches `^--[a-zA-Z0-9_-]+$` and is unique per canvas; every write runs the input through
  `normalizeTokenName` (spaces to hyphens, the `--` added when missing), and the UI shows names
  through `tokenLabel`, without the `--`, so people type `color-primary`. `type` is one of
  `color | opacity | radius | spacing | container | breakpoint | fontFamily | fontWeight |
fontSize | lineHeight | letterSpacing` (`TOKEN_TYPES`, grouped for menus by `TOKEN_GROUPS`).
  `value` is one CSS value (`normalizeTokenValue`: trimmed, under 512 chars, no `;{}<>` or line
  breaks, so a value can never end the declaration or the block early) or `var(--other)` to alias
  another token on the canvas. Aliases must resolve (`resolveToken` follows the chain, null on a
  loop or a missing link); a delete is refused while another token aliases the target.
- `themes` holds the value under each canvas theme where it differs from `value`, which is the
  value of the reserved `default` theme (`DEFAULT_THEME`: always present, never listed, renamed or
  removed). The canvas lists its other themes in `canvas.tokenThemes` (`isThemeName`: a lowercase
  slug other than `default`, at most `MAX_TOKEN_THEMES` 8). A theme is declared the first time a
  token names it, and `set_token_themes` / `PUT /token-themes` replaces the list, applying any
  `renames` (`{ from, to }`, every token's value follows) first; a theme that leaves takes its
  values with it. Every check runs before anything is written, so a bad request changes
  nothing; a theme rename also rewrites `data-doop-theme` in frames. `frameTheme` /
  `withFrameTheme` read and set a frame root's theme; the Tokens tab's theme rows are the editor control.
- Storage: `design_tokens` (migration 0044, PK canvas + name, `themes` jsonb) and
  `canvases.token_themes` jsonb. Hydrated with the canvas like guidelines; duplicates copy both.

## Frames stay self-contained

`withTokenBlock(html, tokens, themeOrder)` runs before the font injection, so a family named only
through a font token is seen by the font scan. It writes the values of the tokens a document names
(`var(--name)` or `var(--name,` outside the block itself, alias targets included) into one
managed `<style data-doop-tokens>` at the top of `<head>`: a `:root{…}` block, then
`:root[data-doop-theme="x"],[data-doop-theme="x"]{…}` per theme with its overrides and, again,
every alias (a custom property's `var()` is substituted where it is declared, so an alias left on
`:root` would keep the default under a themed subtree). Alias chains are checked per theme, and a
delete is refused while any value, default or themed, aliases the token. The block is
replaced when the values differ and removed when the document names no token; the function
returns the input string itself when nothing changes. It runs wherever `withFontFaces` runs:
`withLibraryFaces` in `server/actions.ts` on every frame write (create, update, the final append
chunk, an idle stream close) and `FrameView`'s browser save path. A frame switches theme with
`data-doop-theme="dark"` on its `<html>`, or on one subtree.

## Propagation

A token change (`actions.createTokens` for frames already naming the token, `setTokens`,
`setTokenThemes`) rewrites the block in every frame on the
canvas whose block no longer matches (`restyleTokenFrames`), as an annotation write
(`store.updateFrame`'s `annotation` option): `ready_for_dev` sign-off stands, no version is
filed, one activity line names the token and how many frames were restyled. Frames with an open
append stream are skipped and any rename is queued for the stream's close (their done chunk, or
the idle sweep, brings the block and the rename); a frame mid-reveal is updated and
its playback rewound to where the documents diverge. A rename rewrites `var(--old` references
in every frame and in aliasing tokens.

## API

- REST (`server/index.ts`, `requireCanvas`): `GET /api/canvases/:id/tokens` (view;
  `?format=css|tailwind|md`, JSON otherwise), `POST …/tokens` (edit; `{ tokens: [...] }` or one
  token, one in-band result per entry), `PUT …/tokens/:name` (edit; `value`, `type`,
  `description`, `themes` merged with null removing a theme's value, `newName`, `delete`),
  `DELETE …/tokens/:name`, `PUT …/token-themes { themes }`, and
  `GET …/styleguide.md`: the tokens as tables plus the `:root` CSS, followed by every guideline
  doc, the DESIGN.md a coding agent pulls into a repo.
- Room: `{ type: 'tokens', tokens, themes, actor }` carries the whole list after a change;
  `canvas.tokens` and `canvas.tokenThemes` ride the `init` and `GET /api/canvases/:id`.
- MCP (`server/mcp.ts`): `get_tokens` (types, `name_pattern` glob, `format` json / css /
  tailwind / markdown), `create_tokens`, `set_tokens` (`new_name`, `delete`, `themes`),
  `set_token_themes`. `get_canvas` lists `tokens` and `tokenThemes` and adds `tokensBrief` to its
  note. The resident agent has the same four tools and the brief as a `# Design tokens` system
  block.

## Editor

- Layers panel → Tokens tab (`src/components/TokensPanel.tsx`, a `BracesIcon` tab beside Layers; the
  tab lives in the store as `layersTab`, so the collapsed rail's braces button opens the panel on it):
  laid out like the Pages section. A "Themes" heading whose plus adds `theme-N` at once, over a
  row per theme, `default` first, the picked one ticked: picking one switches the selected frames
  (else every frame on the page) to it through `withFrameTheme`, one undo step per frame, and the
  token rows show that theme's values (`effectiveValue`, an inherited default greyed). A right click on a theme row renames it in
  place (a double click on the name does too; its values follow) or deletes it; `default` is fixed. Then a "Tokens" heading whose plus
  is the menu of the eleven types in their three groups, over one folding row per type (chevron,
  glyph, as a frame in the layer tree) with the token rows under it. Picking a type opens
  `TokenModal` named `stem-N` for it (`nextTokenName`: `radius-1`, `color-2`, past the names
  taken) with the type's default value; the modal has no type control, since a type is fixed
  once a token exists. It has a value control per type (swatch and hex, font and weight lists, a
  number with its unit, a ratio; the number kinds are one well with the type's glyph inside at the left,
  which scrubs the number on drag as the Design panel's fields do from their unit), one value control under a segmented switch of `default` and the themes (a dot marks a
  theme with its own value; a reset beside the field puts it back to following the default), and Enter to
  save; an alias an agent wrote shows as its `var()` text. Names are shown and typed without the `--`.
- Design panel (`ElementPanel.tsx`): fill, stroke and text colour, corner radius and font size
  carry a braces button that overlays the field's unit on hover (`trailing` on `ColorField` /
  `NumberField`, absolutely placed so the value keeps its width); the font family and weight
  selects, each on its own row now, carry a field-height one beside them (`placement="beside"`). It opens a popover
  (`TokenMenu`) listing the canvas's tokens of that type; picking one writes `var(--name)`
  inline. Its "+" opens a card beside the list with the field's current value and a name;
  Enter creates the token and binds the field, Figma's "create variable" from a fill. The menu's
  values and swatches, and a bound chip's swatch, resolve under the frame's own theme
  (`frameTheme`). A bound field wins over a mixed multi-selection reading, and shows the token name as a read-only chip with the resolved swatch, and a broken-chain
  button (`UnlinkIcon`, Lucide's `Unlink`) beside it detaches the field to the literal (`FieldToken`). The runtime's `inline` map also reports the shorthands the panel
  edits (`border-radius`, `border-color`, …), since a `var()` on a shorthand is invisible
  through its longhands. The unit span of a `NumberField` / `TextField` carries `data-unit`,
  which `elementPanelBrowser.test.ts` scrubs by.

## Tests

`designTokens.test.ts` (the block, aliases, exports), `designTokenWrites.test.ts` (frame writes,
propagation as an annotation, rename, delete, duplicate), `designTokensHttp.test.ts` (REST, roles,
exports, themes, MCP, restart). `agentToolParity.test.ts` holds MCP and resident tools in step.

## Not yet

A lint that lists hex and px literals in frames matching an existing token; workspace-scoped
token libraries; components with slots (the second half of #345's neighbour, Figma-style
components).
