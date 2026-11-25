# Components

One design used in many places. People make them from any element; agents make, use and change them
through tools, and read them back in a short form.

## Problems and decisions

| Problem                                             | Decision                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Agents redraw components                            | Catalog in `get_canvas` and the resident prompt; a note on a screen using none |
| Component payloads are expensive to read            | `get_frame` returns `<doop-use>`; the full form is opt-in                      |
| Override ID paths are intricate                     | Attributes are props; part-keyed overrides are there when needed               |
| Agents read pre-override values                     | Instances read back with their real props and overridden parts                 |
| Errors found only in a screenshot                   | Unknown names and values come back in the write's result, with what is valid   |
| Markup or CSS dropped without a word                | A binding on `<doop-use>` and CSS rules not kept are named in the result       |
| Inferred props named `text`, `text-2`               | Named by what the element is, and listed in `create_component`'s result        |
| Edits break the link, or get thrown away            | Any edit becomes the narrowest override that holds it; no detach needed        |
| Sweeping edits have unknown blast radius            | `get_component` shows usage; `update_component` reports impact                 |
| Variant explosion                                   | An enum prop is `data-<name>` on the root, and variants are CSS                |
| Canvases that grew without components               | One copy made a component in place, the rest replaced with `<doop-use>`        |
| Components disconnected from code                   | Optional `code` mapping; compact form reads like JSX                           |
| Libraries silently change consumers, or are one-way | Linked copies; updates shown, pulled on request                                |

## Model

Instances are **materialized in memory and on the wire**: the frame's HTML holds the full markup. Everything
that reads frame markup (comments, Layers, the engine, the room, every client) works unchanged, and a
deleted component loses nothing visually: deleting changes no frame's markup (see Deleting and restoring).

**At rest an instance is a reference** (compact frame storage, `server/frameRest.ts`). The `frames.html`
and `frame_versions.html` columns hold each outermost instance as
`<doop-use component="<id>" id="<element id>" …>` with its props, part overrides and slot content, the
form agents read, named by id so a rename cannot break it; an instance inside a main keeps its part key
too. The rest of the document is stored byte for byte.

- **Storing** (`restingHtml`, called by `server/db/persist.ts` where a frame row or a version is
  written; the debounced row write reads the frame as it stands then, and a write that changed no HTML
  reuses the last result. A canvas copy and a page copy are stored written out, each frame going compact
  on its own first write, so no copy compacts a whole canvas in one turn). An instance is
  reconciled (what was edited inside it becomes its overrides, as a write does), and becomes a reference
  only if that reference, expanded there and then, gives exactly the markup the write pipeline would hold
  for it at the component's current revision. Anything else stays written out: an instance of a component
  that is unknown, deleted, hollow or whose row is not in the database yet (a frame row waits for the
  canvas's queued component writes, and `storedDefs` knows which definitions have landed), one without an
  element id, one holding a hollow component, one a component nested in it cannot render for, one whose
  state the short form would not carry. What each instance becomes is kept by a hash of its markup and the
  state of the definitions it renders from, so a frame saved again pays for the instances that changed.
  A save never fails for this: over budget, the rendered HTML is stored.
- **Reading** (`wakingHtml`, called by the store where frame HTML comes out of the database:
  `fetchHtml` behind `loadPages` / `load` / `loadForFrames`, `renderableFrame`, the version preview and
  restore). References are written out at their components' current markup, at string level, each frame
  in an operation of its own and one frame per turn of the event loop. Instances stored written out (every
  frame from before this, and the ones kept back above) that are marked older than their component's
  `renderRev` are reconciled and rendered at the current revision, which is what the propagation queue used
  to do by rewriting them, and such a row is stored again as read, once, with no version. A frame that
  holds neither is taken as stored, unparsed. A frame that cannot be rendered within its budget does not
  fail the read of its page: its references are read as placeholders (`placeholdUses`, nothing parsed),
  logged, and the next save stores them as the references again.
- **A reference is never dropped.** A deleted component still renders (the frame was stored before the
  delete), frozen as it is. A hollow one renders from its newest kept revision that has markup, logged.
  One that cannot render at all, or whose template nests a component that cannot, stays in the frame as a
  visible placeholder (`data-doop-lost-use`, the reference's source text in it as base64url, logged as
  `[frames] … could not be rendered`); the next save stores it as the reference again, and a read or a
  write after the definition is repaired renders it. A write makes a placeholder a reference again only
  once the whole reference renders (`rendersWhole`): with a nested component still missing it would
  render the rest and record the missing part as hidden for good.
- **Asset references follow a re-render.** A frame rendered again in memory with no row write has its
  `asset_refs` brought up to date (`persist.refreshAssetRefs`); a frame out of memory keeps the ones of
  its last write until it is written again.
- **Both forms are read, always.** Existing frames are stored written out and go compact on their next
  write; there is no backfill. `DOOP_COMPACT_FRAME_STORAGE=false` is the temporary switch back to storing
  instances written out; reading is the same under either setting.
- **Rolling the code back** past this needs the compact rows written out first (switch the setting off and
  write each frame once): older code shows a `<doop-use>` it finds in a row as nothing until that frame's
  next write expands it.

A component's **stylesheet and head tags are not stored in the frames using it** (lean frame storage,
`shared/frameCompose.ts`). A frame's stored HTML is its source; `composeFrameHtml` puts each used
component's `<style data-doop-component-css>` and marked head tags at the end of the head (and the token
block first) wherever a document is rendered or handed on as self-contained: the browser before it posts a
frame into its iframe, the server's renderer for every image and export, `get_frame` with
`expand_components`, the version preview, a pinned reference, and everything sent to a client that does
not compose (the native apps, older bundles). A frame stored before this still carries its blocks; they are
replaced on compose and dropped on its next write. `DOOP_LEAN_FRAME_STORAGE=false` is the temporary switch
back to storing them.

- **Main**: an element with `data-doop-component="<id>"`. Editing it with any tool edits the component.
  A copy of a main elsewhere becomes an instance. If it disappears the component lives on with no main;
  a marker coming back (undo, restore) reclaims the role, and an update writes a new main.
- **Definition** (`components` table, mirrored on `canvas.components`, keyed per canvas so a copied
  canvas's markers stay valid): `template`, scoped `css`, `rawCss`, `head`, `props`, `slots`, `rev`,
  `renderRev`, `mainFrameId`, `code`, `source`.
- **`renderRev`** (`components.render_rev`, null meaning `rev`): the newest revision at which what an
  instance is rendered from (the template, the props) changed. A revision of the rules alone (CSS, head
  tags) raises `rev` and leaves it, so every revision from `renderRev` to `rev` renders the same markup.
  Instances are marked with `renderRev` (`data-doop-rev`), and an instance is behind only when its mark is
  older. `store.saveComponent` sets it on every save, by comparing with the definition it replaces
  (`rendersSame`): a revision is opened before its content is known, so no caller could. It rides wherever
  a definition does (canvas copy, the wire type, soft delete and restore); a library pull, an adoption and
  a restored version get theirs from the same rule. `rev` stays the version of everything else: history,
  `expected_rev`, library publications, detached-CSS keys.
- **Revisions** (`component_revisions`, key `canvas_id, component_id, rev`): what a definition was
  before each change (`template`, `rawCss`, `head`, `props`, its `renderRev`, who and when). The base for
  merging a stale save is the kept state whose span `renderRev`..`rev` holds the instance's mark
  (`stateAtRev`), the current definition when the mark is in its own span: twenty rules-only revisions
  fill the kept history without putting an instance's base out of reach. A row is inserted once
  and never updated; the newest 20 per component are kept and older ones pruned in the same write.
  Memory keeps them as `ComponentDef.history`, loaded at boot, because the three-way merge of a
  stale save reads them synchronously. A save sends the small `components` row plus only the
  revisions not yet filed, inside the component's write queue. Browsers do not get them: `init`,
  `component` messages and REST answers carry a `WireComponentDef` (no `history`), and
  `GET /api/canvases/:id/components/:componentId/revisions` lists them. The old inline
  `components.history` column is no longer read or written; a later migration drops it.
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
- **CSS**: what is passed as `css` to `create_component` / `update_component` sits in the main's frame
  as `<style data-doop-component-source="<id>">`, the component's own CSS, kept apart from the page's.
  Its rules naming something in the main are kept as matched. One naming nothing in the main as it
  stands is kept too when it is anchored to the component (a compound names a class or id of the main's
  own elements, or the root's tag in an attribute state): a state the main is not in yet
  (`.faq-row[open] summary::after`, `details[open] > summary`), an element a script adds, one under a
  theme class (`html.dark .card.is-on`). It is scoped by its subject,
  `:is(<selector>):where([data-doop-instance="<id>"], [data-doop-instance="<id>"] *)`, so only elements
  of an instance are styled, and is named in a `css_unmatched` note in case it is a typo. A rule not
  anchored (a page's rule pasted along, `.hero h1`; a typo; a nested component's alone, `.btn .label`)
  is left out and named in `css_not_kept`. The rest of the main's frame stylesheet (a page a component
  was made from) is matched on what its selectors name, as the server has no CSSOM, over-keeping
  occasionally: a rule whose subject is inside a nested component is taken when its selector reaches
  there from one of the component's own elements (`.plan .btn`), and applies inside this component's
  instances only; a bare `.btn` is the nested component's to carry. Matched rules are scoped with `:where([data-doop-instance="<id>"])`, which adds no specificity.
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
4. Put exactly the needed stylesheets in the head (`syncComponentHead`), so the font and token passes
   that follow read the composed document. What is stored is its source: `storedHtml` strips the
   component blocks and the token block again (a hollow component's stylesheet stays).

Edits map to the narrowest thing that holds them: a bound element to its prop; attributes and individual
style properties to a part override; a deleted element to `hidden`; moved or added children to an `html`
override on that one element, which stays linked above and beside. Setting something back to the
template's value removes the override.

A changed main reaches the frames using it **without writing them**. A frame at rest holds references, so
one that is not in memory needs nothing: it is rendered from the component as it then is when its page is
read. The frames that are in memory are rendered again **in the background** (`server/propagation.ts`): the
write that changed the main only queues the component (`actions.queuePropagation`) and returns. The queue is
per canvas and per frame, visits ONE frame per event-loop tick (`setImmediate` between frames) and lets
canvases take turns; a frame waits once however many components ask for it. For a changed main it takes in
the frames whose HTML is in memory when the work is asked for (the handler's `scope` is `loaded`), reads
nothing and holds no canvas; a frame that leaves memory before its turn is passed over. A visit prepares the
frame as a write would and then:

- the prepared source equals the one in memory: nothing (every frame after a change to the component's
  rules alone, which the room shows from the `component` message, since `renderRev` does not move);
- what the frame stores is unchanged (`sameAtRest`: its instances are references, and the component is what
  moved): `store.rerenderFrame` puts the new rendering in memory. No row, no version, and `updatedAt` stays
  (it is the version a save is checked against, `expectedUpdatedAt`); `frame.rendered` moves instead. The room
  is sent `frame:updated` with `rerender: true` and the frame, which is how a browser gets markup it cannot
  render itself. A browser keeps the newest rendering of a version (`newestRendering` in `src/lib/store.ts`:
  of two copies with one `updatedAt`, the greater `rendered`), so a save's response that left the server
  before the re-render cannot put the old rendering back. Render caches follow: a markup change bumps the
  component's style version (`store.saveComponent`), which retires images of every frame using it, loaded
  or not, and `rendered` is part of a render's stamp (`server/styleVersion.ts`) and of the usage index's;
- what the frame stores changed too (an instance kept written out, a main built from what changed, compact
  storage switched off): an ordinary write, as before. History is filed and the room sees `frame:updated`.

Sign-off stands either way (the frame itself was not edited; decided 2026-11-12), and one activity line
names the frames when the canvas's queue drains. A frame written while it was being prepared is queued again
rather than overwritten; one whose write reads a frame that is not in memory (a copy of a main elsewhere)
has what a write to it reads loaded first. A frame mid-stream catches up when its stream ends, including one
whose agent went silent. `update_component` reports `propagation: { status: 'queued' | 'deferred' | 'none',
frames }`; `update_library_everywhere` loads each canvas, waits for its queue and reports the frames that
now show the update. Queued work is in memory and needs no catch-up after a restart: a frame is current when
it is read (the boot sweep `catchUpComponentsBehind` and its query are gone). `DOOP_DEFER_COMPONENT_PROPAGATION`
still skips the queue for frame writes: frames in memory then follow on their own next write, or the next
read of their page. The `detach` task, and a changed main on a canvas whose frames live on an actor, still
take in every frame: the canvas is loaded and held until the queue drains.

## Deleting and restoring

Delete is **soft** (`status: 'deleted'`, `deletedAt`, `deletedBy` on the definition; migration
`0058_component_soft_delete`). `deleteComponent` marks the definition and writes **no frame**: it used to
detach every instance on every frame in one synchronous request.

- **Instances** of a deleted component keep their markup byte for byte. At rest too: `deleteComponent`
  stores each loaded frame using it again, its instances of the deleted component written out (an
  instance holding one in a slot stays written out with it), so a later change to a component nested in
  it cannot reach them; a reference a row still holds from before the delete renders as the component
  was. A reference is likewise kept written out until every definition it names, the ones placed in its
  slots included, is in the database. They are left out of
  everything that follows a main: `prepareInstances` skips them (no reconcile, no upgrade), the propagation
  queue drops deleted ids, and their stylesheet is still composed in (`componentClosure` finds the
  definition, deleted or not).
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

Compact storage tests: `frameRest.test.ts` (the round trip and its idempotence, overrides of every kind,
element ids, a main's nested instances, a property-style run over frames made at random through the real
write paths, the damaged-definition cases, cost, a changed main with pages in and out of memory),
`compactFramesHttp.test.ts` (the real server and database under both settings: restarts, an inline edit
kept as an override, versions, copies, a missing definition, a database holding both forms),
`frameRerenderStore.test.ts` (the browser's side of a re-render), `componentsBehind.test.ts` and
`componentsCatchUp.test.ts` (instances stored behind are current when read), `workBudgetCommit.test.ts`
(its modelled database holds frames at rest).

## Work budget

The engine is synchronous, and what it costs is parsing. Every engine parse goes through `parse` /
`parseFragment` in `server/workBudget.ts`, which charge the **operation** they run in: an
`AsyncLocalStorage` context opened per HTTP request (middleware in `server/index.ts`), per MCP tool call
(`withArgsCanvases`), per resident tool call (`execTool`), per frame of the propagation queue and for an
idle stream's settling pass. An operation may hand the parser `DOOP_WORK_BUDGET_PARSE_MB` (96) of HTML and
spend `DOOP_WORK_BUDGET_MS` (2000) inside it; the time is parser time, not wall time, so a tool call that
awaits a render is not charged for the wait. Past either limit the parse throws `WorkBudgetError`, which
names the operation and the canvas: REST answers 422 `work_budget_exceeded`, MCP and the resident agent
return it as the tool's error, and the queue skips that frame and leaves it in memory as it was (its row,
which holds references, reads back current). A page read gives each frame an operation of its own, so
expanding a page's references is not one budget; a kept template is parsed once, not once per instance
(`keptTemplate` in the engine), and costs nothing after that.
`prepareFrameHtml` puts back any definition it had already saved (a main folded in, a library component
taken up), and `updateComponent` its own, so a refused write leaves nothing behind. The budget is
checked before a parse (bytes that do not fit are never parsed) and again after it, so the parse that took
an operation over its time is refused itself, including an operation's last one. Every write therefore
parses first and saves after: `updateComponent` reads the template before it saves props or a name, a new
main's empty frame is removed if its write is refused, a stream chunk's library adoption is put back (also when the last chunk's whole-frame pass is the one
refused, and the room hears of an adoption only after the chunk is in the frame), and an
import of several components takes back the ones it had made. A check that runs after a write has landed
(the css-not-kept note, reuse notes, reading instances back, an inserted instance's id) goes
through `optional()`: out of budget it is left out, never turned into a refusal of a finished write.
A sync that had already updated a
dependency says what it updated (`WorkBudgetError.afterPartialWork`). `workBudgetCommit.test.ts` makes each
parse of each writing operation the one that goes over, and requires the operation to land whole or leave
the canvas exactly as it was.
Work outside any operation (a timer, a socket message) is counted per event-loop turn and only logged.
Tests: `workBudget.test.ts`, `workBudgetHttp.test.ts`.

## Usage counts

`server/componentUsage.ts` answers "where is each component used" for a whole canvas from one pass over
its frames: a string scan for instance markers, never a parse, kept per frame until that frame is written
(its `updatedAt` moves) or rendered again (its `rendered` moves). `catalog(canvas)` (the list in `get_canvas`, `list_components` and the
resident prompt) takes every component's count from that one pass instead of splitting every frame once per
component. `update_component`'s impact (instances, frames, approvals affected) reads the same index and
parses no frame; there is no dry run and no orphaned-override report, since an update is undone with
`restore_component_version`. Tests: `componentUsage.test.ts`.

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
- A definition that goes hollow (its row lost its markup and rules) has no stylesheet to compose: a frame
  stored lean shows its instances unstyled until the main is written again. A frame stored before lean
  storage keeps the copy it holds. A reference to it renders from its newest kept revision; with none
  kept it is a placeholder until the main is written again.
- A reference renders with the component as it is when the frame is read, so a version preview shows a
  version's instances at today's markup, not the markup of the day it was filed (its props, overrides and
  slot content are the version's own).
- A save parses the frame once more than before (to find its instances; about 2 ms for a 115 KB frame),
  on the debounced row write. `tests/frameRestBench.test.ts` prints what a heavy page costs to read and
  store.
- Workspace libraries (publish once, use on every canvas of the workspace) are their own spec:
  [workspace-component-library.md](workspace-component-library.md).
