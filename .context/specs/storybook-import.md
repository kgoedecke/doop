# Storybook import

A team's real components, from its Storybook, as Doop components on a canvas, with its theme as
the canvas's tokens and its fonts in the font library, kept in step with code by re-syncing. Agents
then compose screens from the team's own parts (`<doop-use>`), not lookalikes.

Origin: a customer built this by hand (an exporter that lifts stories and an agent that sends each
part over MCP, 2026-11-19). Their findings shaped it: CSS from the CSSOM, variants from the class
differences between renders, Tailwind's escaped classes, hover-only rules, `.dark`.

## Shape

An extension (`server/storybook/`, `src/integrations/storybook/`), removable as a unit.

1. **Acquire**: render each story and capture it in the page (`shared/storybookCapture.ts`,
   `captureStoryInPage`, self-contained so it runs in any Chromium). The server does it for a public
   Storybook in its renderer (`server/storybook/browser.ts`); the CLI
   (`cli/doop-storybook.ts`, served as `/cli/doop-storybook.mjs`) does it on the developer's machine
   for `localhost` or a private Storybook and sends the captures over MCP with an agent key.
2. **Build**: captures → component inputs and tokens (`shared/storybookKit.ts`, pure).
3. **Write**: tokens, fonts, components on the canvas, the source remembered for sync
   (`server/storybook/importer.ts`, `storybook_sources`).

## Reading a Storybook

- `<base>/index.json` (v4/v5 `entries`, v3 `stories.json`): stories (not docs) grouped by `title`;
  a component is a title, named by its last segment (`Components/Button` → `Button`; a clash takes
  more of the path). `componentPath` (else `importPath`) becomes the component's `code.path`.
- One story per component is the **base**: the one named `Default`/`Primary`/`Basic`/`Playground`,
  else the first. A person or agent can pick another.
- Props come from the preview's own story store (`__STORYBOOK_PREVIEW__.storyStoreValue.loadStory`):
  `argTypes` with 2-12 `options` (select, radio, union of literals) and booleans become **enum**
  props (booleans as `false`/`true`); string args whose value shows as text become **text** props
  (`data-doop-prop`). Names are kebab-case lowercase (`buttonText` → `button-text`).
- Each enum value other than the default is rendered once, the others at their default, by
  `updateStoryArgs` on the preview's channel (waiting for `storyRendered`). At most
  `MAX_VARIANT_RENDERS` (24) per component; a prop past that is left out and said.

## Capturing a story

- The root: `#storybook-root` (`#root` before v7)'s one visible child, else the root itself; when
  the root is empty, the largest visible portal in `body`.
- HTML: the root cloned, scripts and Storybook scaffolding out, React/Radix generated ids out.
- CSS: every rule in `document.styleSheets` (the CSSOM, so CSS-in-JS counts) that could apply to
  an element of the root with states, pseudo-elements and `:not()` relaxed, inside its
  `@media`/`@supports`/`@container`/`@layer` wrappers (layers flattened); keyframes it names;
  `@font-face` rules for the families it uses. Document rules (`:root`, `html`, `body`) are not
  copied; the root's own computed text style is (font, colour, size, line height, smoothing), on
  `:where(.sb-root)` so the component's own rules win over it as they did in the story.
- Custom properties the rules read, resolved transitively on the root, in light and (when the
  Storybook has a dark theme: `globals.theme`, `backgrounds`, `prefers-color-scheme`) in dark.
- URLs absolutized against their stylesheet. The CLI turns resources only it can reach into
  `data:` URIs, which the server uploads as assets (frames never hold base64).
- The root's box, and in the server a PNG of it for the fidelity check.

## Building a component

- Variant CSS: a class present in the renders of some values of a prop and not others belongs to
  that prop; its rules are rewritten to `.sb-root[data-<prop>="<value>"]` (root) or
  `.sb-v<k>:is(.sb-root[data-<prop>="<value>"] *)` (a descendant, marked `sb-v<k>`, one marker per class and prop condition), and the class
  leaves the markup. Descendants only when the renders have the same element tree. A value whose
  render differs in markup, not just classes, is noted (Doop variants are CSS).
- Rules: `(hover: hover)` unwrapped and `(hover: none)` dropped (canvas = desktop with a mouse);
  `.dark` gets `[data-doop-theme="dark"]` beside it; Tailwind's `--tw-*` defaults trimmed to the
  ones used; duplicates out.
- Tokens: a custom property whose value is a colour becomes a `color` token, `--radius*` a
  `radius`, `--font-*` with a family list a `fontFamily`; dark values as the `dark` theme. The rest
  stay on the component's root rule (`.sb-root{--x:…}` plus a dark override).
- `description`: the story's `parameters.docs.description.component`, else "<title> from Storybook".

## Writing

- Tokens: missing ones created; ones this source created before updated to the new value; any
  other existing token of the same name left alone and said.
- Fonts: each `@font-face` file fetched (or taken from the capture) and added to the canvas's font
  library (`addCanvasFont`); the family named in CSS is renamed to the library family when they
  differ. Plan limits come back as notes.
- Components: created with `create_component`, through `runComponentTool`, so every check and note
  an agent gets applies. A component this source made before is updated (`update_component`) when
  its build changed (content hash) and skipped when not. A same-named component the source did not
  make is left alone and said.
- Fidelity: the main rendered (`renderFrame`, layer `[data-doop-component]`) against the story's
  PNG, sized alike, as a share of matching pixels. Under 90% is flagged.
- One progress task ("Storybook Import") shows on the canvas while it runs, as Figma's does.

## Sync

`storybook_sources` (migration 0066): one row per canvas and Storybook URL, with the picked
components (title, base story, props) and what each became (component id, hash), and the tokens it
created. Sync re-runs the import for that row. Entry points: the import section's "Sync now", MCP
`sync_storybook`, and the CLI's `push` (which is a sync when the source exists), so CI can call
it after deploying a Storybook.

## Surfaces

- REST (`/api/canvases/:id/storybook`, edit role): `POST /discover {url}` → components;
  `POST /import {url, components}` → 202 + task; `GET /sources`; `POST /sources/:sourceId/sync`.
- MCP: `import_storybook` (url, optional component titles; or `captures` from the CLI),
  `sync_storybook`, `list_storybook_components`. Long imports run on; the tool waits up to 50s and
  then answers with the job's progress, `import_storybook` with `job_id` waits again.
- UI: "Storybook" in the import picker: URL → component checklist → import; existing sources with
  Sync now and the last result per component (fidelity, notes).

## Limits

`MAX_STORYBOOK_COMPONENTS` 60 per import, `MAX_VARIANT_RENDERS` 24 per component, 400 KB of CSS
per component (past it, the component is skipped and said), the shared import rate slot.
Not handled: shadow DOM (web components) is noted and captured as its light DOM; canvas/WebGL
paints nothing; interaction states that need a `play` function render as the story leaves them.
