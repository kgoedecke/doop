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
| Markup or CSS dropped without a word                | A binding on `<doop-use>` and CSS rules not kept are named in the result            |
| Inferred props named `text`, `text-2`               | Named by what the element is, and listed in `create_component`'s result             |
| Edits break the link, or get thrown away            | Any edit becomes the narrowest override that holds it; no detach needed             |
| Sweeping edits have unknown blast radius            | `update_component` reports impact, with `dry_run`                                   |
| Variant explosion                                   | An enum prop is `data-<name>` on the root, and variants are CSS                     |
| Canvases that grew without components               | `create_component` + `replace_matching` retrofit them                               |
| Components disconnected from code                   | Optional `code` mapping; compact form reads like JSX                                |
| Libraries silently change consumers, or are one-way | Linked copies; updates shown, pulled on request                                     |

## Model

Instances are **materialized**: the frame's HTML holds the full markup. Everything that reads frame HTML
(iframes, thumbnails, PDF and image export, comments, Layers) works unchanged, and a deleted
component loses nothing visually: deleting writes no frame at all (see Deleting and restoring).

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
  `<doop-use>` by id, so a rename cannot break them. The template attributes mean nothing on a
  `<doop-use>`: they are dropped with an `ignored_attribute` issue that says what to write instead.
- **Inferred props** (`inferBindings`, only for markup with no `data-doop-prop` of its own): leaf text,
  image sources and link targets. A name comes from `data-name`, else the last class that is not a
  utility class, else what the element or its nearest ancestor is (`h1`-`h6` title, `button` / `a`
  label, `img` image, `li` item, otherwise text); a link's target is `link` or `<name>-link`.
  `create_component` lists them as `inferred_props`.
- **CSS**: the server has no CSSOM, so rules are matched on what their selectors name, over-keeping
  occasionally. A rule whose subject is inside a nested component is kept when its selector reaches
  there from one of the component's own elements (`.plan .btn`), and applies inside this component's
  instances only; a bare `.btn` is the nested component's to carry. Rules passed as `css` to
  `create_component` / `update_component` that were not kept come back as a `css_not_kept` issue naming
  their selectors. Rules are scoped with `:where([data-doop-instance="<id>"])`, which adds no specificity.
  Inherited declarations and used custom properties from `html` / `body` / `:root` land on the instance
  root. Stylesheet links and the Tailwind CDN script are carried as `head`.

## The write pipeline

`prepareFrameHtml` runs synchronously inside every `actions.ts` write:

1. Expand `<doop-use>` at string level (a parser would foster-parent one out of a `<table>`).
2. Fold a changed main into its definition: a new revision, reported as `changed`. One
   `update_component` call is one revision: when it changes props it opens the revision itself, and
   the main's write that follows fills it (`withinRevision`) rather than adding a second.
3. Reconcile each outermost instance: render its own `rev` with its marker's state, diff against the
   incoming markup, record differences as overrides, render at the current revision. Unchanged input
   stays byte-identical. This three-way step is what stops a stale client's save being taken for edits.
4. Put exactly the needed stylesheets in the head.

Edits map to the narrowest thing that holds them: a bound element to its prop; attributes and individual
style properties to a part override; a deleted element to `hidden`; moved or added children to an `html`
override on that one element, which stays linked above and beside. Setting something back to the
template's value removes the override.

A changed main is then carried to the frames using it **in the background** (`server/propagation.ts`): the
write that changed it only queues the component (`actions.queuePropagation`) and returns. The queue is per
canvas and per frame, visits ONE frame per event-loop tick (`setImmediate` between frames) and lets canvases
take turns, so no request rewrites a canvas synchronously; a frame waits once however many components ask
for it, and a canvas with work pending stays loaded and held. Each visit is an ordinary write: history is
filed, sign-off stands (the frame itself was not edited; decided 2026-11-12), the room sees `frame:updated` (the `component`
message goes out when the change is queued), and one activity line names the frames when the canvas's queue
drains. A frame written while it was being prepared is queued again rather than overwritten. A frame
mid-stream catches up when its stream ends, including one whose agent went silent. `update_component`
reports `propagation: { status: 'queued' | 'deferred' | 'none', frames }`; `update_library_everywhere` waits
for each canvas's queue and reports what it changed. Queued work is in memory: after a restart, a frame not
reached yet catches up on its own next write. `DOOP_DEFER_COMPONENT_PROPAGATION` still skips the queue for
frame writes.

## Deleting and restoring

Delete is **soft** (`status: 'deleted'`, `deletedAt`, `deletedBy` on the definition; migration
`0058_component_soft_delete`). `deleteComponent` marks the definition and writes **no frame**: it used to
detach every instance on every frame in one synchronous request.

- **Instances** of a deleted component keep their stored markup byte for byte and are left out of
  everything that follows a main: `prepareInstances` skips them (no reconcile, no upgrade), the propagation
  queue drops deleted ids, and their stylesheet stays in the head (`closureOf` still finds the definition).
  They read back in full, not as `<doop-use>` (`compactDocument`), and take no props or overrides
  (`changeInstances` refuses; detaching one still works).
- **New uses** are refused: a `<doop-use>` naming a deleted component is left out with a
  `deleted_component` issue, and `insert_instance` fails. A name resolves to the component in use first, so
  a new component may take a deleted one's name.
- **Its main** is frozen: markup carrying the marker stays where it is as ordinary markup of that frame. An
  edit to it (an old client's save, a paste) changes only that frame, never the definition, and does not
  bring the component back (`prepareMains` skips it).
- **Nested use**: a component built from a deleted one keeps rendering as it did. A `<doop-use>` that
  already wears a part key is a template's own, not a new use, so the outer component's main, its template
  and new instances of it still expand the deleted definition, frozen at its last revision.
- **Restore** (`restoreComponent`): active again under its name, or `<name> (restored)` if that was given
  away. The main is the markup still carrying the marker, re-read through an ordinary write so that edits
  made to it meanwhile become a new revision; if none is left, a main is written from the kept definition.
- **Detach all** (`detachAllInstances`) is its own, explicit act: the `detach` task of the background queue
  (`server/propagation.ts`), one frame per tick, each an ordinary write. A frame an agent is streaming into is not rewritten under it: its request is
  kept outside the queue (`defer`) and resumed when the stream closes or is abandoned (`finishStream` →
  `propagation.resumeFrame`). It is not undone by a restore.
- Surfaces: `DELETE /api/canvases/:id/components/:componentId`, `POST …/undelete`,
  `POST …/detach-instances`; MCP and the resident agent share `delete_component` (with
  `detach_instances`) and `restore_component`; `get_canvas` lists `deletedComponents` that still have
  instances; `GET …/components` and every catalog list the components in use only (`activeComponents`).
  In the editor, Delete in the Components panel soft-deletes, and the Design tab on an instance of a
  deleted component shows "Main component deleted" with Restore and Detach (`ComponentSection.tsx`).
- **Libraries**: a library's publication holds the components it can publish and the deleted ones those
  are built from (`publication` in `componentLibrary.ts`), so a published Card that nests a deleted Button
  still brings its Button. Such a snapshot is a dependency only: `librariesForCanvas` does not offer it,
  a canvas adopting it gets it already deleted, and it leaves the publication once nothing in use is built
  from it. On the consuming side a locally deleted link is frozen: `pullFromLibrary` (sync_component and
  update everywhere), its dry-run preview and a copy import's sync skip it, so its template, CSS and
  revision stay as they were while the component built from it moves on. A copy import (`import_component`
  from a canvas that is not a workspace library) brings the deleted components its target is built from
  the same way: copied as they stand, still deleted, with no main. Tests:
  `libraryDeletedComponents.test.ts`.
- A deleted definition is never purged, and does not count towards `MAX_COMPONENTS`.

Tests: `componentSoftDelete.test.ts`, `componentSoftDeleteRoutes.test.ts`,
`componentSectionDeleted.test.tsx`.

## Work budget

The engine is synchronous, and what it costs is parsing. Every engine parse goes through `parse` /
`parseFragment` in `server/workBudget.ts`, which charge the **operation** they run in: an
`AsyncLocalStorage` context opened per HTTP request (middleware in `server/index.ts`), per MCP tool call
(`withArgsCanvases`), per resident tool call (`execTool`), per frame of the propagation queue and for an
idle stream's settling pass. An operation may hand the parser `DOOP_WORK_BUDGET_PARSE_MB` (96) of HTML and
spend `DOOP_WORK_BUDGET_MS` (2000) inside it; the time is parser time, not wall time, so a tool call that
awaits a render is not charged for the wait. Past either limit the parse throws `WorkBudgetError`, which
names the operation and the canvas: REST answers 422 `work_budget_exceeded`, MCP and the resident agent
return it as the tool's error, and the queue skips that frame and leaves it materialized as it was.
`prepareFrameHtml` puts back any definition it had already saved (a main folded in, a library component
taken up), and `updateComponent` its own, so a refused write leaves nothing behind. The budget is
checked before a parse (bytes that do not fit are never parsed) and again after it, so the parse that took
an operation over its time is refused itself, including an operation's last one. Every write therefore
parses first and saves after: `updateComponent` reads the template before it saves props or a name, a new
main's empty frame is removed if its write is refused, a stream chunk's library adoption is put back (also when the last chunk's whole-frame pass is the one
refused, and the room hears of an adoption only after the chunk is in the frame), and an
import of several components takes back the ones it had made. A check that runs after a write has landed
(the css-not-kept note, lookalike and reuse notes, reading instances back, an inserted instance's id) goes
through `optional()`: out of budget it is left out, never turned into a refusal of a finished write.
`replace_matching` stops instead and reports `matching_stopped`; a sync that had already updated a
dependency says what it updated (`WorkBudgetError.afterPartialWork`). `workBudgetCommit.test.ts` makes each
parse of each writing operation the one that goes over, and requires the operation to land whole or leave
the canvas exactly as it was.
Work outside any operation (a timer, a socket message) is counted per event-loop turn and only logged.
Tests: `workBudget.test.ts`, `workBudgetHttp.test.ts`.

## Usage counts

`server/componentUsage.ts` answers "where is each component used" for a whole canvas from one pass over
its frames: a string scan for instance markers, never a parse, kept per frame until that frame is written
again (its `updatedAt` moves). `catalog(canvas)` (the list in `get_canvas`, `list_components` and the
resident prompt) takes every component's count from that one pass instead of splitting every frame once per
component. `update_component`'s impact report reads the same index, and looks for orphaned overrides only
in frames that can hold one (an overrides marker, or a slot / nested component at a part the new template
drops), within a quarter of the operation's parse budget; frames it had to leave out are counted in
`overrides_unchecked_frames`. Tests: `componentUsage.test.ts`.

## Agent surface

`server/componentTools.ts` holds each tool's schema and handler once, for MCP and the resident agent:
`list_components`, `get_component`, `create_component`, `update_component`, `insert_instance`,
`update_instances`, `delete_component`, `restore_component`, `restore_component_version`,
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
- A component made from markup is not placed anywhere; the result says to write `<doop-use>` or call
  `insert_instance`.
- A component cannot pass its props on to a component nested in it. The nested one takes fixed
  values, or the spot is a slot each instance fills.
- Figma import does not map Figma components to these.
- A restored revision older than the 20 kept cannot be used for merging: its instance keeps its marker
  state and upgrades.
- `@scope` is not used, so a host frame's own rules for the same class still apply to an instance.
- Workspace libraries (publish once, use on every canvas of the workspace) are their own spec:
  [workspace-component-library.md](workspace-component-library.md).
