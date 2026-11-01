# Component library and global stylesheet

A design system every canvas of a team draws from: one **global stylesheet** (tokens as `:root`
custom properties, fonts, base rules) and a **library of components** sorted into groups. People
register components in the browser; agents read the library over MCP (or in the resident agent's
system prompt) and compose frames out of it.

## Scope

A library belongs to a scope (`libraryScopeOf` in `shared/designSystem.ts`): `workspace:<id>` for
a canvas in a workspace, else `user:<ownerId>`, else `canvas:<id>` for an unowned canvas. Moving a
canvas between spaces switches the library it draws from; frames keep their stamped blocks until
their next write.

Reading follows the canvas (any role) or workspace membership. Changing follows
`canEditLibrary` (`server/library.ts`): workspace members for a team library, only the owner for a
personal one (never a share-link visitor), the canvas edit role for an unowned canvas.

## Groups and presets

`PRESET_GROUPS` are fixed (Buttons, Collections, Colors, Controls, Data display, Date and time,
Feedback and loading, Forms, Layout, Media, Navigation, Overlays, Pickers, Typography, Utilities),
each listing preset **kinds** (Button, ButtonGroup, …, ScrollShadow: 73 in all). Every kind has a
ready-made starter in `shared/componentPresets.ts` (markup, CSS reading the tokens, JS where it
behaves); `{{s}}` there stands for the slug. Custom groups (`component_groups`) sit after the
presets; one can only be deleted once empty. The interface translates preset group names
(`library.group*` keys, `groupLabel` in `src/lib/library.ts`); agents see the English names.

## Components

`LibraryComponent`: `slug` (unique per scope, `COMPONENT_SLUG_RE`), `name`, `groupId`, optional
`kind`, `description` (written for agents), `html` (default markup), `css` (this component only),
`js`, and named `variants` (extra markup). `saveComponent` puts `data-doop-component="<slug>"` on
the markup's root (`ensureInstanceAttribute`) and names it with `data-name` (`ensureInstanceName`,
following a rename). The Layers panel (`src/lib/layers.ts`) shows an instance by that name with the
component glyph and its slug (an unnamed one by its titled slug), and any element by its
`data-name`. An element nobody named is never shown as a bare tag: `src/lib/layerLabels.ts` builds
"role · context" from its tag, ARIA role or control type (else its one meaningful class, utility
classes skipped, else "Group"), and its ARIA label, field label, heading, first text or item count
("Card · Bancos", "Field · Número", "List · 3 items"; empty boxes are "Spacer"), translated through
the `layers` i18n namespace, with the tag or class faint beside it; MCP instructions, the guide and the resident prompt ask agents to name the blocks they
write. The library's first write makes the default
stylesheet real (`design_systems` row); until then the snapshot offers it with `initialized: false`.

## Stamping

An instance is any element with `data-doop-component="<slug>"`. `stampLibrary` (shared, used by
the server and the editor's preview) brings a document's `data-doop-library` blocks in line:
`tokens` (the global stylesheet) whenever the frame uses a component or one of its tokens, plus
`css:<slug>` and `js:<slug>` per component used, inserted first in `<head>` so frame rules win.
Component JS is wrapped to run once after parsing with `elements` bound to every instance. A slug
the library no longer has keeps the block the frame carried (deleting a component never strips its
instances); blocks of components no longer used go. Closing tags inside CSS/JS are escaped. The
function is idempotent and returns the input unchanged when nothing moves.

`actions.createFrame`, `actions.updateFrame` and the final chunk of `appendFrameHtml` stamp every
durable write. Every library write runs `actions.restampLibrary`: it restamps all frames of the
scope (skipping live streams and reveals), renames instances on a slug change, logs one activity
line per canvas and broadcasts `{ type: 'library' }` so open library views refetch. Restamping is a
design change, so approved frames move to `needs_review`.

## API

`server/libraryRoutes.ts`, under `/api/library`, the library named by `?canvas=<id>` or
`?workspace=<id>`; every answer is the fresh `LibrarySnapshot`:

- `GET /` · `PUT /styles` `{ globalCss?, notes? }`
- `POST /groups` · `PATCH /groups/:id` · `DELETE /groups/:id`
- `POST /components` · `PUT /components/:id` (partial) · `DELETE /components/:id`

Tables (migration 0040): `design_systems` (scope PK), `component_groups`, `library_components`
(unique `scope, slug`), hydrated into memory at boot like workspaces.

## Agents

- MCP: `get_design_system` (tokens, rules, groups, components with markup; `include_css` for the
  code), `save_component` (create or update by slug, `new_slug` renames), `delete_component`,
  `set_design_system` (stylesheet and usage rules), `create_component_group`. `get_canvas` reports a
  `designSystem` summary and a note; the server instructions and the guide's "Design system"
  section tell agents to place components by markup, never copy their CSS, and use tokens.
- Resident agent: `designSystemBrief` (tokens, rules and each component's markup) rides in the
  system prompt after the guidelines, under one cache breakpoint.

## UI

- Canvas: a **Components** tab in the side panel (`ComponentsPanel`), searchable by group; a row
  inserts its component into the selected frame (one undo step) or a new centred frame
  (`insertComponent` in `src/lib/library.ts`). **Library** opens `LibraryBrowser` in a modal.
- Workspace page: a **Components** pane with the same `LibraryBrowser`.
- `LibraryBrowser`: groups down the side, live previews (`ComponentPreview`, a sandboxed iframe
  through `previewDocument`), an add tile per unfilled preset kind, custom groups, the
  `GlobalStylesEditor` (stylesheet, usage rules, token list with swatches) and `ComponentEditor`
  (identity, HTML/CSS/JS/variants, live preview; a preset draft follows its slug until its code is
  touched). Every string is in the `library` i18n namespace (English and Brazilian Portuguese).

Tests: `designSystem.test.ts` (stamping, helpers, every preset), `library.test.ts` (REST, stamping
and restamping frames, rename, access, workspace scope, restart), `mcpLibrary.test.ts` (tool
contract).
