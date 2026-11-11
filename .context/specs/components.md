# Components

One design used in many places. People make them from any element; agents make, use and change them
through tools, and read them back in a short form.

## Problems and decisions

| Problem                                             | Decision                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Agents redraw components                            | Catalog in `get_canvas` and the resident prompt; a note when a write has lookalikes |
| Component payloads are expensive to read            | `get_frame` returns `<doop-use>`; the full form is opt-in                           |
| Override ID paths are intricate                     | Attributes are props; part-keyed overrides are there when needed                    |
| Agents read pre-override values                     | Instances read back with their real props and overridden parts                      |
| Errors found only in a screenshot                   | Unknown names and values come back in the write's result, with what is valid        |
| Edits break the link, or get thrown away            | Any edit becomes the narrowest override that holds it; no detach needed             |
| Sweeping edits have unknown blast radius            | `update_component` reports impact, with `dry_run`                                   |
| Variant explosion                                   | An enum prop is `data-<name>` on the root, and variants are CSS                     |
| Canvases that grew without components               | `find_component_candidates` + `replace_matching` retrofit them                      |
| Components disconnected from code                   | Optional `code` mapping; compact form reads like JSX                                |
| Libraries silently change consumers, or are one-way | Linked copies; updates shown, pulled on request                                     |

## Model

Instances are **materialized**: the frame's HTML holds the full markup. Everything that reads frame HTML
(iframes, thumbnails, PDF and image export, comments, Layers) works unchanged, and a deleted
component loses nothing visually.

- **Main**: an element with `data-doop-component="<id>"`. Editing it with any tool edits the component.
  A copy of a main elsewhere becomes an instance. If it disappears the component lives on with no main;
  a marker coming back (undo, restore) reclaims the role, and an update writes a new main.
- **Definition** (`components` table, mirrored on `canvas.components`, keyed per canvas so a copied
  canvas's markers stay valid): `template`, scoped `css`, `rawCss`, `head`, `props`, `slots`, `rev`,
  `mainFrameId`, `code`, `source`, and the last 20 revisions inline.
- **Instance**: root attributes `data-doop-instance`, `data-doop-rev`, `data-doop-id`, and when needed
  `data-doop-props` / `data-doop-overrides` as JSON. Every element keeps its `data-doop-part` key.
  Slot content and nested instances are read from the DOM, not repeated in the marker.
  A nested instance's id is derived from its owner's id and part key, so it stays the same across
  renders and through the short form without being stored. Detaching leaves `data-doop-detached-from`
  on the root and a frozen copy of the component's CSS scoped to it, one per revision per frame.
- **Template markup**: `data-doop-prop` binds text, attributes, styles and custom properties;
  `data-doop-if` makes elements conditional; `data-doop-slot` / `data-doop-slot-suggest` declare slots.
  Enum props exist only in the definition and set `data-<name>` on the root. Nested components are
  `<doop-use>` by id, so a rename cannot break them.
- **CSS**: the server has no CSSOM, so rules are matched on what their selectors name, over-keeping
  occasionally. Rules are scoped with `:where([data-doop-instance="<id>"])`, which adds no specificity.
  Inherited declarations and used custom properties from `html` / `body` / `:root` land on the instance
  root. Stylesheet links and the Tailwind CDN script are carried as `head`.

## The write pipeline

`prepareFrameHtml` runs synchronously inside every `actions.ts` write:

1. Expand `<doop-use>` at string level (a parser would foster-parent one out of a `<table>`).
2. Fold a changed main into its definition: a new revision, reported as `changed`.
3. Reconcile each outermost instance: render its own `rev` with its marker's state, diff against the
   incoming markup, record differences as overrides, render at the current revision. Unchanged input
   stays byte-identical. This three-way step is what stops a stale client's save being taken for edits.
4. Put exactly the needed stylesheets in the head.

Edits map to the narrowest thing that holds them: a bound element to its prop; attributes and individual
style properties to a part override; a deleted element to `hidden`; moved or added children to an `html`
override on that one element, which stays linked above and beside. Setting something back to the
template's value removes the override.

`propagateComponents` then rewrites each referencing frame as an ordinary write: history is filed, sign-off
on an approved frame moves to `needs_review`, the room sees `frame:updated` and a `component` message, and
one activity line names the frames. A frame mid-stream catches up when its stream ends, including one whose agent went silent.

## Agent surface

`server/componentTools.ts` holds each tool's schema and handler once, for MCP and the resident agent:
`list_components`, `get_component`, `create_component`, `update_component`, `insert_instance`,
`update_instances`, `find_component_candidates`, `delete_component`, `restore_component_version`,
`import_component`, `sync_component`. Previews are `get_component_preview` (MCP) and
`screenshot_component` (resident). `get_canvas` carries the catalog; `get_frame` and `edit_frame_html` speak
the compact form. Instructions are `COMPONENTS` in `server/guide.ts`.

## Editor

Layers / Components switch in the left rail (`ComponentsPanel.tsx`): search, previews, click to place, repeated
design scan, library import. `ComponentSection.tsx` heads the Design tab: props, go to main, reset, detach on an
instance; description and make-a-prop / make-a-slot on a main. Right-click and ⌘⌥K create one.

## Limits

- Variants are styled in CSS, through agents or the HTML tab. There is no visual per-variant editing yet.
- Placing is by click; no drag from the panel onto the canvas.
- Selection outlines do not yet distinguish mains and instances; the Layers glyph and Design tab do.
- The Components page frame for a main made from markup uses a default size until resized.
- Figma import does not map Figma components to these.
- A restored revision older than the 20 kept cannot be used for merging: its instance keeps its marker
  state and upgrades.
- `@scope` is not used, so a host frame's own rules for the same class still apply to an instance.
- Resident agents cannot import libraries: their run is scoped to one canvas.
