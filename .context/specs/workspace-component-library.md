# Workspace component library

A workspace publishes components once and every canvas in it can use them, by hand or through an
agent. On a canvas that cannot have a library, the same spot in the Components panel says how to
get one, which on the hosted product is the Team plan.

This sits on top of [components.md](components.md) and changes nothing about how a frame holds an
instance. The older linked copy between any two canvases a person can read (`import_component`
from a canvas that is not a library, "Import from another canvas" in the panel) is unchanged and
stays free.

## Model

**A library is a workspace canvas that has published.** The team keeps its mains on a canvas they
already know how to edit; there is no second editor.

- `library_components` (migration `0053_library_components`, mirrored in memory by
  `server/componentLibrary.ts`): one snapshot per published component, keyed `canvasId` + `id`,
  holding name, description, template, css, rawCss, head, props, slots, code, `nested` (which
  other library each nested component came from), a `rev`,
  `publishedAt`, `publishedBy`. `rev` is the publication's version: the library canvas's revision
  when taken, raised past the previous publication's when a change left that revision alone (a
  description, the code mapping), since consumers tell an update by a higher `rev`. A canvas is a library while it has
  rows; it serves whichever workspace it is in (read from the canvas, not stored), so moving it
  moves its library and taking it out of a workspace withdraws it.
- **Publishing is an explicit step and stores a snapshot.** Consumers read the snapshot, never the
  live definition, so work in progress on the library canvas reaches nobody. A snapshot rather
  than a `publishedRev` pointer because a definition keeps only its last 20 revisions.
- Publishing takes all of the canvas's own components or a named selection, each with what it is
  built from. A published component the canvas no longer has stops being offered at the next
  publish. Components linked from another library are not re-published from here.
- Withdrawing (`unpublish`, or deleting the canvas) deletes snapshot rows only. Canvases using a
  component keep their definition and every instance.

### Using one

- `librariesForCanvas(canvas)` is every other canvas of `canvas.workspaceId` with snapshots, and
  empty unless the workspace is active. It goes by the canvas, like fonts, so a guest editing a
  workspace canvas has its library without being a workspace member.
- Taking a component up adds a **linked definition with no main** to the canvas
  (`adoptFromLibrary`): the snapshot's fields, the library's component id, local `rev` 1 and
  `source: { canvasId, componentId, rev, library: true }`. Ids are kept, so nested `<doop-use>`
  by id and the scoped CSS work as published. No frame is written. What it is built from comes
  along, from its own library or from another library of the workspace (a Plan card published
  around the design system's Button), found through the source the publication recorded for
  it (`nested`, migration `0055_library_nested_sources`), never by id alone, since copied canvases
  share ids; a name already taken here gets a "(library)" suffix; an id that is the canvas's own
  component (a copied canvas shares ids) is refused before anything is written.
- **Resolve on write.** `prepareFrameHtml` and `prepareChunk` pass `contextFor` a
  `LibraryAdoption`, so a `<doop-use>` (or a pasted instance marker) naming something the canvas
  lacks is looked up in its libraries and adopted in the same write. A local component always
  wins the name. Two libraries publishing the name is the issue `library_ambiguous`, settled by
  `import_component` with the library's canvas id. Reads (`get_frame`, previews) never adopt.
- `actions.announceAdopted` then tells the room and carries **tokens**: those the component's
  markup and CSS name (alias chains included) that the canvas lacks are created with the
  library's values and themes; a token of the same name here is left alone. Inside a frame write
  this waits a microtask, since adding tokens restyles frames.
- A linked definition is read-only here: `update_component` (and so rename and restore) is
  refused with the library canvas's id, and a main for it pasted into a frame here becomes an
  instance (`prepareMains`) instead of claiming the definition. Instances take props and overrides as usual, and deleting
  the component detaches them as usual.

### Updates

- Never pushed by publishing: a publish changes no other canvas. `originOf(canvas, def)` finds the
  snapshot a link follows; a newer `rev` there is `library_update_available` in the catalog and an
  entry in `GET /api/canvases/:id/library`. A publication is pushed only by the explicit "update
  everywhere" action below.
- `sync_component` on a library link (`pullFromLibrary`) checks the snapshot's whole closure first (an id
  this canvas has as its own component, or no room for what is new, refuses the pull with nothing
  written), then walks it: new
  dependencies are adopted, older links get the snapshot as a new local revision (`relink`),
  tokens the update starts naming are carried, and
  `propagateComponents` carries it to every instance as an ordinary write, so history is filed and
  approved frames keep their sign-off. It is not plan-gated beyond the library still serving
  the canvas.
- A publish or a withdrawal sends `{ type: 'library' }` to every open room of the workspace
  (`actions.broadcastLibrary`); the panel reads its library again.

### Update everywhere

One action from the library's side pulls its latest publication into every canvas of the workspace
that uses it (`updateLibraryConsumers` in `server/componentActions.ts`). It is a separate request,
never a side effect of publishing, and it applies what is published, not work in progress.

- It walks `libraryConsumers(canvas)` and, for each canvas that is behind, runs the same
  `pullFromLibrary` as `sync_component`. So on each canvas it is an ordinary component update:
  history is filed, approved frames keep their sign-off, the room is told. It is
  attributed to whoever asked, and each canvas gets one activity line naming the library.
- Frame HTML is loaded per canvas, and a pull rewrites the consumer's frames, so each consumer is
  loaded (`store.load`) and held while it is worked on, one canvas at a time. The action is async
  for that reason.
- It changes only canvases the acting account may edit (`canvasRole`): the signed-in person over
  REST, the connecting account over MCP, and for the resident agent the person who asked for the
  run (a run nobody asked for, such as an automation, changes no other canvas). The others are skipped and
  listed in the report, without id or name when the account cannot open them. It needs the same
  entitlement as publishing (`requireLibraryPlan`), and a canvas that has published nothing is
  refused.
- A refusal on one canvas (a `ComponentError`, such as an id clash) is reported for that canvas and
  the rest go on.
- The report: `canvases` (`canvas_id`, `canvas_name`, `updated` component names, `frames_changed`,
  `approvals_withdrawn`) and `skipped` (`reason` `no_edit_access` or `failed`, `message`).
  `dry_run` returns the same shape and changes nothing: there `frames_changed` counts the frames
  holding an instance of what would update and `approvals_withdrawn` the approved ones among them.
  A dry run loads the canvases too, since counting reads their frames.

## Entitlement

One rule, `libraryBlock(canvas)`: a library needs a canvas in a workspace that `isActive`. With
billing off every workspace is active, so the feature is free on a self-hosted server. Publishing
and taking a component up check it (`requireLibraryPlan` → `LibraryPlanError`); REST answers 402
with `workspace_plan_required` (and the workspace id) or `library_needs_workspace`; agents get a
sentence to relay to the person. Nothing about plans is added to `get_canvas`.

### Who may publish

A workspace sets who publishes to its library: everyone who can edit the library canvas (the
default, and all there was before the setting) or its owner and admins only. It is
`workspaces.library_publish` (migration `0054_library_publish_policy`; null is everyone, `admins`
restricts), `libraryPublish` on `WorkspaceSummary`, changed by an admin through
`PATCH /api/workspaces/:id { libraryPublish }` from the Workspace page's General pane.

- One gate, `requireLibraryPublisher` in `server/componentActions.ts`, called by
  `publishToLibrary` and `unpublishFromLibrary`, which is everything REST, MCP and the resident
  agent publish or withdraw through. Both take the acting account's id: `req.user.id` on REST,
  the connecting account on MCP, the run's requester for the resident agent (`ToolContext.userId`).
  An agent publishes as the person it works for; a resident run nobody requested (an automation)
  has no account and publishes only where everyone may.
- The refusal is a `LibraryPublisherError`: HTTP 403 with the sentence as `error` and
  `code: 'library_publish_restricted'`, and the same sentence as the tool's error for an agent to
  relay. A dry run is refused too, so an agent hears it before preparing a publish.
- Only publishing and withdrawing are restricted. Using a library, pulling updates and editing
  the library canvas's components are unchanged; a member's edits there wait for an admin to
  publish them.
- `GET /api/canvases/:id/library` adds `canPublish` (the setting applied to the viewer; true on a
  canvas in no workspace). Where it is false the panel offers no publishing: no "unpublished
  changes" notice and no dot for it, no first-publish button, no "Publish to library…" in a
  component's menu.

## Surfaces

- **Agents** (`server/componentTools.ts`, so MCP and the resident agent alike): `get_canvas` lists
  `workspaceLibraries` (what is published and not yet used here, each with its signature and a
  ready `<doop-use>`), the resident kickoff has the same as a "Workspace library" block,
  `list_components` adds `workspace_libraries` and marks linked components with `library`,
  `import_component` and `sync_component` understand library links (`sync_component` without a
  component pulls every update waiting on the canvas), and `publish_library` publishes
  (`components`, `dry_run`) or withdraws (`unpublish`); its result's `used_by` lists the canvases
  using the library and what each still has to pull, limited to canvases the account can open.
  `update_library_everywhere` (`dry_run`) is the update-everywhere action: its description tells an
  agent to use it only when the human asks for the change on every canvas, and to run the dry run
  first. It is the one async component tool, so `runComponentTool` returns a promise and
  `ToolContext` carries `canEdit` beside `canRead`. Guide text is in `COMPONENTS`.
- **REST**: `GET /api/canvases/:id/library` (status, changes, waiting updates),
  `POST /api/canvases/:id/library/publish`, `DELETE /api/canvases/:id/library`,
  `POST /api/canvases/:id/library/update-consumers` (`{ dryRun? }`, edit role on the library
  canvas; answers with the report),
  `GET /api/canvases/:id/component-libraries` (libraries first, flagged `library`),
  `GET …/components/:componentId/preview?library=<canvas>` (a snapshot's preview),
  `GET /api/workspaces/:id/libraries` (members only; `behind` is how many of `usedBy` are on an
  older publication). `GET /api/canvases/:id/library` also lists `behind` for a library canvas: the
  canvases on an older publication, among those the viewer can open.
- **Editor** (`src/components/LibrarySection.tsx`, `src/lib/library.ts`, mounted in
  `ComponentsPanel.tsx`): a section per library with previews, where a click adds the component
  and places an instance, and a card dragged onto a frame or the paper is taken up on the drop and
  lands where one of the canvas's own would (`dropLibraryComponent` in `src/lib/components.ts`,
  payload `LIBRARY_COMPONENT_DRAG_TYPE`; a drag let go elsewhere, or over a locked frame, adds
  nothing); what waits is said first (`LibraryNotices`, at the top of the tab, on an accent tint with a
  `brand` button): unpublished changes with Publish changes, and waiting updates with Update all,
  and the Components tab wears a dot for either (`libraryAttention`); publishing opens a checklist
  dialog (and Stop sharing); a canvas that has not published yet has a quiet first-publish button
  under its components; "Publish to library…" in a
  component's menu. A library with everything published and canvases behind says "N canvases are
  on an older version" in the same notice area, with Update everywhere
  (`LibraryUpdateEverywhere.tsx`): a confirmation naming the number of canvases and that approved
  frames that change go back to review, then a notice with what was updated, sent back to review
  and skipped. The tab's dot does not count this. A linked component wears the book glyph, has no Rename, and "Open its
  library" in place of "Go to main".
- **Opening a library**: a library canvas opened by a link naming no page, frame or element lands
  on the page its components are on, not the first page. The server decides which
  (`landingPageOf` in `server/componentLibrary.ts`, from frame metadata, so no frame HTML is
  loaded): the page holding the most published components' main frames, a tie going to the page
  named "Components", then to page order. It rides on the canvas the GET and the room's `init`
  hand out as `landingPageId`, never stored, so the editor opens on that page in its first paint
  (`openingPageId` in `src/lib/pageLink.ts`). It is unset for a canvas that has published
  nothing, or whose published components have no main on a page, and such a canvas opens on its
  first page; a canvas that has components but is not a library is not affected. It applies when
  the canvas is opened only: a page the person switches to, or a `page` / `frame` link, wins, and
  on a library the first page's URL carries `?page=` since a bare link opens the components. The
  value is read at join, so a canvas that starts or stops being a library while open keeps its
  old default until it is opened again.
- **Workspace page**: a Libraries pane beside Fonts (`WorkspaceLibraries.tsx`, every member):
  each library canvas with its component count, how many canvases use it, how many of those are
  on an older version and when it last published, a button to open it and, while any are behind,
  the same Update everywhere.
- **Upsell**: where the library section would be, a canvas that cannot have one shows a
  dismissible card ("Reuse components across canvases"). Its link, and "Publish to library…" on
  such a canvas, start `LibraryUpgradeFlow`: the workspace's plan when that is what is missing
  (`UpgradeModal` with the reason), else a workspace to move the canvas into, created on the spot
  for someone with none and leading to its plan when it needs one (and back afterwards, see
  "After checkout"). With billing off the card
  only talks about moving the canvas into a workspace. Dismissal is per browser
  (`doop:library-upsell`); the card returns once for a canvas with five components.
  `shared/billing.ts` lists the library among the Team plan's features.
- **Events**: `library_upsell_shown` / `_clicked` / `_dismissed` from the browser, `paywall_shown`
  from `UpgradeModal`, and through `captureFeature` with `via`: `library_published`,
  `library_component_used`, `library_update_pulled`, `library_updated_everywhere`.

## After checkout

Stripe Checkout leaves the app and returns to the workspace page
(`/w/<id>?checkout=success`, see [workspaces-billing.md](workspaces-billing.md)). The library
flow picks up from there with a note kept in the browser (`src/lib/libraryResume.ts`,
`localStorage` key `doop:library-resume`); the server and the checkout URLs are unchanged, so
there is no return address for anyone to tamper with.

1. `LibraryUpgradeFlow` passes `UpgradeModal` an `onCheckout` that writes the note just before
   the browser goes to Stripe: the canvas, the workspace being paid for, and the component when
   they started from one component's "Publish to library…".
2. On `checkout=success` the workspace page syncs billing as before. When the plan is live and
   the note is for this workspace, `confirmLibraryResume` marks it `paid` and the page navigates
   to `/c/<canvas>` (the id is checked for shape and the path goes through `safeRelativeTarget`).
   `checkout=canceled` deletes the note.
3. `CanvasPage` opens the Components tab when a note names its canvas. `useLibraryResume` in
   `ComponentsPanel` decides with `resumeStep` once the library status is known: open
   `PublishLibraryDialog` (with `only`) when the canvas is in that workspace, entitled and the
   viewer may publish; move the canvas into the workspace first when it is in none and the note
   is `paid`; leave the note while the workspace's plan is not live yet; drop it when the canvas
   sits in another workspace, or the viewer cannot edit or may not publish.

The note is removed from storage before anything is done with it, so it acts once. It lasts 30
minutes (`RESUME_TTL_MS`), a note of another shape reads as none, and the furthest it goes is an
open dialog: publishing is still the person's click. Only a `paid` note moves a canvas, so
pressing Back out of Stripe moves nothing. It is per browser, so a checkout finished in another
browser or device does not resume.

Sending a library's changes to every canvas follows the publish setting: where a workspace keeps
publishing to its owner and admins, update-everywhere is theirs too.

## Limits

- A snapshot's preview renders nested components from the library canvas's live definitions.
- A workspace-wide token library is not part of this: tokens are copied with the components that
  name them.
- The publish setting is per workspace, not per library canvas, and has two values; there is no
  list of named publishers.

## Tests

`libraryPlan.test.ts` (billing on: a personal canvas, a live plan, a lapsed one and its return),
`workspaceLibrary.test.ts` (the real server: publish, resolve on write, tokens, updates, access,
the 402, the publish setting and its 403), `libraryUpdateEverywhere.test.ts` (the real server
after a restart: who is behind, the dry run, canvases loaded to be updated, withdrawn sign-off, a
caller who may not edit), `libraryTools.test.ts` (the agent tools over MCP; the publish setting
with the role lookup mocked), `librarySection.test.tsx` (the panel, the card, its drag payload,
the publish dialog, the update-everywhere notice, and no publishing where `canPublish` is false),
`workspaceLibraries.test.tsx` (the Workspace page's pane), `libraryDrop.test.ts` (a library card's
drop: import, then place), `libraryResume.test.ts` (the note's expiry and shape, the way back from
the workspace page, and `resumeStep`). The Stripe round trip itself is not run by any test.
