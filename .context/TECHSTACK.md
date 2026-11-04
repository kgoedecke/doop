# TECHSTACK - doop

## 1. Language and Runtime

- TypeScript 5.9 (strict mode) - primary language across `server/`, `src/`, and `shared/`.
  `bun run typecheck` uses `tsgo` (`@typescript/native-preview`, the TypeScript 7 Go compiler) for
  speed; the JS `typescript` package serves editors and the ESLint parser.
- Node.js - runtime; `tsx` 4.23.9 runs server TypeScript directly with no build step, both in dev
  (`tsx watch`) and prod (`NODE_ENV=production tsx server/index.ts`).
- Bun 1.3.10 - pinned via `packageManager` in `package.json`; used as the package manager and
  script runner, not as the server runtime.
- Rust (stable) - `desktop/src-tauri`, the Tauri desktop shell.

## 2. Core Frameworks and Libraries

- Express 4.19.2 - HTTP server framework in `server/`.
- React 18.3.1 - UI framework in `src/`.
- Zustand 4.5.4 - client-side state management.
- Element ids (`shared/elementId.ts`): anything outside a frame that points at an element
  inside it uses the element's `data-doop-id` attribute, stamped into the frame HTML the first
  time something needs it (a comment, an element link, a layer rename, whose undo and redo find the element by it) and kept by agents like every other
  `data-doop-*` attribute. The server stamps (`server/elementIds.ts`, parse5 by source offset,
  so nothing else is re-serialized; `actions.ensureElementId`, exposed as
  `POST /api/frames/:id/element-id` to the comment role) as an annotation: `store.updateFrame`'s
  `annotation` option keeps `ready_for_dev` sign-off, and no version or activity line is written.
  A positional path that does not resolve in the saved HTML (a script-made element, a frame
  mid-stream) is refused, and a comment falls back to the frame at its point. The frame runtime's
  probe reports an existing id as `elementId`; its positional `cssPath` is now only the editor's
  internal selection language.
- Element links use `/c/<canvasId>?frame=<frameId>&element=<data-doop-id>` (no selector form,
  and no backwards compatibility for the old one). `src/lib/elementLink.ts` owns copying from the
  element toolbar and Layers menu, stamping first when the element has no id; `Stage.tsx`
  focuses its page and frame; `FrameView.tsx` resolves the id in the ready iframe, including
  script-created elements, re-picks the positional path so the Layers panel follows, and falls
  back to frame details if nothing carries the id. Browser regressions in
  `tests/pageCanvasBrowser.test.ts` cover initial loading, cross-page links, stamping on copy,
  clipboard round trips, history and script-created or script-removed elements.
- Radix UI primitives (`@radix-ui/react-*`, ^1.x-2.x) + shadcn 4.19.0 - accessible UI primitives
  generated into `src/components/ui`.
- `@anthropic-ai/sdk` 0.115.0 and `@modelcontextprotocol/sdk` 1.12.0 - power the built-in Doop
  Agent and the MCP server that lets external agents (e.g. Claude Code) design on a canvas.
- Design inspiration (`server/inspiration.ts`, `search_inspiration` in MCP and the resident agent):
  One Page Love's API (`ONEPAGELOVE_API_KEY`; unset, the tool tells agents to brief without an
  exemplar). `/v1/search` resolves the query to taxonomy filters, `/v1/inspirations?status=live`
  returns the sites with style, colour, fonts and sections, dropping the broadest filter until
  something matches; six-hour in-memory cache for the free plan's 1,000 requests a day. Every
  result credits One Page Love and the authors with the entry's link (their terms). Tests:
  `inspiration.test.ts`.
- Agent feedback (`server/agentFeedback.ts`, `shared/agentFeedback.ts`): agents talk to the Doop
  team through two MCP tools, which the resident agent has under the same names. `report_issue`
  (kind `issue`: `bug`, `tool_error`, `confusing`, `missing_capability`, `other`) is for where Doop
  got in their way; `share_feedback` (kind `feedback`: `idea`, `improvement`, `praise`, `other`) is
  for what would help or what worked. Each takes a message and optionally the tool and canvas
  involved. Both land in `agent_feedback` with the account and the MCP client's name. `/mcp` is
  stateless (a fresh server per request), so `handleMcpRequest` remembers the `initialize`
  clientInfo name per credential (a hash of the bearer) and falls back to the OAuth application's
  name. Reports go to PostHog as `agent_feedback_reported` with `kind` and share a cap of 20 an hour
  per account. Instance admins read them at `GET /api/admin/agent-feedback` (Admin → Agent
  feedback), 50 at a time with `kind`, `q` (searched on the server, account email included) and a
  `before=<at>:<id>` cursor for older pages. They never reach the humans on a canvas. Tests:
  `agentFeedback.test.ts`, `agentFeedbackHttp.test.ts` (separate HTTP requests).
- Claude Code on the desktop (`shared/localAgent.ts`, `server/localAgent.ts`,
  `desktop/src-tauri/src/claude.rs`): the model menu is the CLI's aliases (`CLAUDE_MODEL_ALIASES`),
  which `claude --model` resolves to the newest model the installed CLI knows, plus a pinned
  `claude-*` id accepted by shape (`isClaudeModel`, mirrored by `valid_model` in the shell before the
  value becomes an argument); `effort` (`CLAUDE_EFFORTS`, `local_agent_preferences.effort`) rides the
  job and becomes `--effort`. A pre-alias shell's "Invalid model" is reworded by
  `localAgentRuns` into an update prompt. Which `claude` runs: the one picked in Settings
  (`claude_choose_cli`, a native file panel, never a page-supplied path; `cli.json` in the app's
  data dir), else what the login shell's `command -v claude` names (aliases included) when it is
  2.1+, else the newest known install. The shell is asked once per launch (`$SHELL -l -i -c`, 5s
  bound; Refresh asks again) and its `PATH` is given to every CLI process, since a GUI app's
  `/usr/bin:/bin` PATH lacks the `node` an npm install needs. Shells advertise this with
  `__DOOP_CLAUDE_CHOOSE__`.
- Model menus (`server/modelCatalog.ts`, `GET /api/model-account/models`): the connected
  account's picker asks the provider's catalog with the user's own key when it opens (the
  composer's `ModelPicker`) or mounts (Settings, `useAgentModels`), merging the curated entries of
  `shared/modelMenu.ts` / `shared/localAgent.ts` on top as `recommended`; a provider without a
  loader, or one that cannot be reached, gets the curated menu with `live: false`. Anthropic and
  OpenAI (`/v1/models`), Gemini (`/v1beta/models`) and ChatGPT subscriptions (the Codex backend's
  catalog, `CHATGPT_MODELS_URL`, asked with the account's token as Codex CLI
  `CHATGPT_CODEX_CLIENT_VERSION`; the route refreshes the token first) have loaders, each with a
  family filter for reasoning chat models with tools, images and a 16k output window; a picked id
  only has to be shaped like the provider's, and the run is the final check. OpenRouter stays on
  its curated roster (the run-time vision check knows only the roster's flags).
- Reasoning effort on a user's OpenAI account (ChatGPT subscription or OpenAI key): the pick lives
  in `model_accounts.reasoning_effort` (`REASONING_EFFORTS` in `shared/modelMenu.ts`: low / medium /
  high / xhigh), set through `PATCH /api/model-account { effort }`, read by `effortFor` in
  `server/openaiAgent.ts` for every turn, with `DOOP_AGENT_OPENAI_EFFORT` as the default until a
  user picks. The status reports the resolved `effort` for the OpenAI kinds only, which is what
  shows the `Segmented` switch in Settings and the radio group in the composer's `ModelPicker`.
- Pages over MCP (`server/mcp.ts`): `get_canvas` lists `pages` (id, name, `startFrameId`) and
  every frame's `pageId`, and narrows to one page with `page_id`; `create_canvas_page` adds an
  empty page at the end (`actions.createCanvasPage`, a server-minted id, `MAX_PAGES` enforced)
  and returns it for `create_frame`'s `pageId`; `set_canvas_pages` stays the whole-list call for
  rename, reorder and delete; `update_frame` moves a frame between pages. The guide's "Frames
  and HTML" section says when a page beats a frame. Tests: the page cases in `mcp-tools.test.ts`.
- `ws` 8.18.0 - WebSocket server for realtime multiplayer (cursors, presence, frame edits,
  activity feed) over one room per canvas.
- Custom fonts (`shared/fonts.ts`, `server/fonts.ts`, `server/fontFile.ts`): font libraries, one
  per workspace (used on its canvases) and one per person (used on their personal canvases),
  managed in Settings → Fonts and Workspace → Fonts (`FontLibrary.tsx`, strings in the `fonts`
  catalog) over `/api/fonts`
  (`?workspace=` for a workspace's, members only); `GET /api/canvases/:id/fonts` is a canvas's.
  Uploads are TTF/OTF/WOFF/WOFF2 up to 10 MB, one face per file; `fontFile.ts` reads format,
  family (name id 16, else 1), weight (a variable font's `wght` range) and style from the bytes,
  with no font library dependency (zlib for WOFF, brotli for WOFF2), every decompression bounded
  before it starts (1 MB per metadata table, 48 MB for a WOFF2 stream). Bytes are an ordinary `/a/`
  asset, so removing a font never breaks a frame that loads it; re-uploading a face replaces it
  (writes queue per library, so racing uploads of one face leave one row).
  A frame stays self-contained: `withFontFaces` adds the `@font-face` rules for the library
  families its CSS names to one `<style data-doop-fonts>` block in its own HTML (only adds, never
  removes). `actions.createFrame` / `updateFrame` / the final append chunk run it on every write,
  and `FrameView`'s save path runs it too, so a family picked from the Design panel's "Custom
  fonts" group renders at once. Every renderer that reads frame HTML (screenshots, PDF
  export, iOS) gets the font that way. Agents see the library as `fonts` plus a note in
  `get_canvas` and as a system block in the resident agent (`libraryBrief`): name the family,
  never load it from Google Fonts. Tests: `fonts.test.ts` (a real WOFF2 in `tests/fixtures/fonts`), `fontLibrary.test.ts`,
  `fontLibraryRace.test.ts`, `fontFrameWrites.test.ts` (faces on create, stream end and idle; an idle close sends viewers the
  healed document, so a cut-off script never runs).
- Design tokens (`shared/designTokens.ts`, spec `.context/specs/design-tokens.md`): a canvas's
  typed design values (Paper's eleven types: colour, opacity, radius, spacing, container,
  breakpoint, font family / weight / size, line height, letter spacing), each a CSS custom
  property frames use as `var(--name)`, with a value per theme (`canvas.tokenThemes`; a frame
  switches with `data-doop-theme="dark"` on its `<html>`). `withTokenBlock` writes the values a
  frame names into its own `<style data-doop-tokens>` block wherever `withFontFaces` runs, and a
  token change rewrites that block in every frame naming it as an annotation (sign-off stands, no
  version). Stored in `design_tokens` + `canvases.token_themes` (migration 0044); REST under
  `/api/canvases/:id/tokens`, `/token-themes` and `/styleguide.md` (tokens + guidelines as one
  markdown); MCP `get_tokens` (json / css / tailwind / markdown), `create_tokens`, `set_tokens`,
  `set_token_themes`, mirrored on the resident agent; the Layers panel's Tokens tab
  (`TokensPanel.tsx`) and token menus on the Design panel's colour, radius and font-size fields.
  Tests: `designTokens.test.ts`, `designTokenWrites.test.ts`, `designTokensHttp.test.ts`.
- Hosted fonts (`shared/webFonts.ts`): the Design panel's font menu offers the "Fonts" group, a
  curated roster of open families on Google Fonts (`WEB_FONTS`, each with its css2 axes), plus
  two "Device fonts" (system UI, system monospace) labelled as varying by viewer; the OS stacks
  (Georgia, Verdana, Trebuchet, Helvetica, Arial, Times, Courier) were dropped from the menu since
  the server's renderer has none of them and exports disagreed with the editor. Naming a roster
  family in CSS is all it takes: `withWebFontLinks` adds one `<link rel="stylesheet"
data-doop-webfonts>` for the roster families the frame names and does not load itself (a
  library family of the same name wins, and leaves the link when uploaded later), run wherever
  `withFontFaces` runs (`actions` on every write, `FrameView`'s save path). The screenshot and
  PDF renderers already admit the two Google Fonts origins. Agents get the roster as `webFonts`
  plus a note in `get_canvas` and in the resident agent's `# Fonts` block (`webFontsBrief`).
  Self-hosted instances without outbound internet render roster fonts as their generic in
  exports. Tests: `webFonts.test.ts`, the hosted case in `fontFrameWrites.test.ts`, the font pick in
  `elementPanelBrowser.test.ts`.
- Fonts from this computer (`src/lib/localFonts.ts`, `desktop/src-tauri/src/fonts.rs`): in the
  desktop shell the font library card has "Add from this computer" (shells advertise it with
  `__DOOP_LOCAL_FONTS__`). `fonts_choose_local` opens the native file panel in the platform's
  fonts folder (the person's own first) and remembers the picks; `fonts_read_local` hands the
  page one picked file's bytes once, by that path and no other, and the page uploads it through
  the ordinary `POST /api/fonts`, so a local font becomes a library font rather than a
  device-only reference. Collections (`.ttc`, `.dfont`) and files over 10 MB are left out by
  name. A confirm dialog before the upload says the fonts are shared with the library and that
  OS fonts are often licensed for one person; Doop checks no licences (Figma's posture for shared
  fonts). Tests: the Rust unit tests in `fonts.rs`, `localFonts.test.ts`.
- Profile photos (`shared/avatar.ts`, `server/avatars.ts`): Settings → Your account → Photo uploads a
  PNG/JPG/WebP/GIF under 2 MB as raw bytes to `POST /api/me/avatar`, which stores it as an ordinary
  immutable `/a/` asset and points better-auth's `user.image` at it; `DELETE /api/me/avatar` puts the
  initials back. `avatarUrl` is the one rule for what a face may load: only such `/a/` uploads, never
  a social provider's picture or a URL set through the raw update-user call, so no account can make
  every viewer fetch an address it chose. The `Avatar` primitive takes `image` (a photo that fails to
  load falls back to the initials); it rides `Presence` (set at `join`, re-announced to the person's
  rooms on a change), `/api/me`, the session, canvas `people`, the share list and workspace members.
  Tests: `avatar.test.ts`, `avatarFace.test.tsx`.
- Outside a canvas room, `GET /api/me/events` (`server/userEvents.ts`, Server-Sent Events, one
  stream per tab) pings a user's open pages with `{ type: 'canvases' }` when a canvas or workspace
  membership adds or removes them (the workspace pings come from `addMember`, `removeMember`,
  `acceptInvite` and `deleteWorkspace` themselves). Home (`src/hooks/use-user-events.ts`) refetches
  on each ping and every time the stream opens, dropping a response older than one already shown.
  Inviting someone to a canvas also emails them once (`server/canvasShares.ts`, SMTP only). Tests:
  `canvasShares.test.ts`, `userEventsHttp.test.ts`.
- Frame image export (`src/lib/frameRaster.ts`, `src/lib/frameExport.ts`): the PNG / JPG download
  and Copy as PNG are drawn by the browser showing the frame, not by the server's Chromium. The
  runtime answers `doop:snapshot` with its live document (`exportSnapshot`: what an HTML copy
  loses is captured first, every `<canvas>` as its pixels, each `<img>` at the source the
  browser picked, a `blob:` image as its bytes, every stylesheet as the CSSOM holds it, adopted
  sheets included; `html: null` when a canvas is tainted, and the export goes to the server; `snapshotFrame` in
  `frameBridge.ts`, the store's HTML only when the frame is not mounted: a mounted frame that
  does not answer within its 15s is unreadable, and the server renders), `inlineDocument` turns it
  into one SVG sized to the frame, every image, stylesheet (both `@import` forms, cycles cut)
  and font fetched and inlined as a data: URL (an SVG drawn as an image loads nothing itself;
  scripts and `srcset` are dropped, a link's `media` kept; a nested document (iframe, object, embed) sends
  the frame to the server, since it would be a hole in the picture),
  and the SVG is drawn onto a canvas at 2x from a data: URL (a blob: URL taints the canvas in
  Chromium) and encoded. A resource the browser cannot fetch (an image host without CORS)
  rejects the whole render and the export falls back to `/i/<id>.<ext>` as before, so what the
  person sees on the canvas is never the export's blocker. An element inside a frame exports
  too (the element menu's Export as PNG / JPG and Copy as PNG, `downloadElementExport` /
  `copyElementPng`): the frame is rendered whole and cut to the element's live box
  (`doop:inspect` rect, `clipToFrame`, the raster's `clip` option), so every style it inherits
  and whatever paints behind it stay in the picture; a server render is cropped here the same
  way (`cropRaster`), and a frame off screen says so. Tests: `frameRaster.test.ts`,
  `frameRasterBrowser.test.ts` (pixels in Chromium, the live runtime included),
  `frameExport.test.ts`.
- `pdf-lib` 1.17.1 - joins the vector PDF export (`server/pdfExport.ts`): headless Chrome prints
  each frame onto a page of its own size, pages in the order the frames are listed (a whole page
  in canvas reading order, `shared/frameOrder.ts`; the Export checklist sends its displayed
  order); render limits in `shared/pdfLimits.ts`, which also sizes the browser's download
  timeout; served by `GET /api/canvases/:id/export.pdf` and MCP `export_frame`.

## 3. Data and Persistence

- PostgreSQL 16 (`postgres:16-alpine` in `docker-compose.yml`) - primary database.
- drizzle-orm 0.45.2 + drizzle-kit - schema in `server/db/schema.ts` and
  `server/db/auth-schema.ts`; migrations generated via `npx drizzle-kit generate` into
  `server/db/migrations`, applied at boot by `server/db/index.ts` (never by drizzle-kit itself).
- `@electric-sql/pglite` 0.5.4 - embedded Postgres so `bun run dev` works with zero external
  services.
- `pg` 8.22.0 - Postgres driver for the real-database path.
- Automations (`shared/automations.ts`, `server/automations.ts`) support schedules and
  approval triggers scoped to one canvas. The five-second worker groups up to ten signed-off
  frames per run. `automation_approvals` retains dispatch receipts independently of the
  pruned run log. Run state stores the approved source identities, frozen steps, current
  step, task ID, summaries and result links; database leases serialize execution. Agent tasks
  and their wait points commit together. The next step waits for completion, checks source
  approvals and access again, and stops on failure or after one hour. Interrupted external
  calls require a destination check rather than automatic replay. Integration-owned action
  hooks create Linear issues or send Slack messages using the workflow owner's connection.
  Approval presets create draft sizes, translations and companion assets on the watched canvas.
  The worker queues independent workflows with concurrency four and keeps discovering work
  while integrations await I/O. Receipt lookup is batched. Later agent briefs include earlier
  draft-result links and completion summaries, so localization can build on generated sizes.

## 4. Canvas Drawing

- Canvas zoom: the camera runs from 8% to 1600% (`MAX_ZOOM`, mirrored by `FOLLOW_MAX_ZOOM`).
  `Stage.tsx` lays the `.world` out at CSS zoom k, the settled camera zoom clamped
  to 1-16, and its transform carries only the camera's movement since (`scale(zoom / k)`).
  Chromium passes k into each frame iframe (and the drag preview) as pixel density, so frame
  documents keep design-px viewports and rasterize at k×, out of process too (a transform on
  the iframe only stretched a 1× raster there); k is the whole number at or above the zoom,
  since the iframe box snaps to whole pixels and only a whole k keeps every design size exact.
  Elsewhere (`FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY` false) each `FrameView` iframe undoes k (`zoom: 1/k`, `scale(k)`); `src/lib/layoutZoom.ts` snaps k to a
  float32 whose inverse multiplies back to exactly 1, since engines multiply zoom in float32.
  WebKit (the desktop app) rasterizes a composited layer at its CSS size, so a transform-only
  scale went soft past 100%. Both engines tile what is on screen, so backing memory follows the
  viewport, not k. From 300% a 1px pixel grid fades in over the frames (full at 500%). Frame
  names sit inside their frame, counter-scaled by `--zoom`, so they keep size and gap at every
  zoom and stack with their own frame (a later frame covers an earlier frame's name, never the
  reverse). The selected frame's size badge lives in a screen-space layer (`FrameLabelLayer`),
  placed from `--vx`/`--vy`/`--zoom`. ⇧1 / ⇧2 (fit all / fit selection), frame deep links and
  fly-tos fit into the stage area the top bar and floating panels leave open: `CanvasPage` passes
  `Stage` the `insets` its chrome covers and `fitBox` (`src/lib/viewFit.ts`) centres there.
  Tests: `viewFit.test.ts`, `fitSelectionBrowser.test.ts`.
- Canvas panel layout (Settings → Appearance → Canvas panels, `src/lib/panelLayout.ts`, per
  browser under `doop:panel-layout`): `floating` (the default) keeps the islands over a
  full-window stage; `docked` makes Layers, the tool rail, the icon islands, the Inspector /
  element panel and Agents flush columns (`Panel surface="docked"`), the bar a solid strip
  (`TopBar variant="docked"`), and the stage itself the gap between them (`Stage bounds`), so its
  rulers sit on its own edges and fits need no insets. Phones and ⌘. ignore it. `chromeLayout` in
  `CanvasPage.tsx` holds both geometries; docked panels keep the stage at least 320px wide as far as their minimums allow, and ⌘V / image drops centre on the stage (`stageViewportSize`), not the window. Tests: `panelLayout.test.ts`, the docked case in
  `fitSelectionBrowser.test.ts`.
- Stacking (`shared/frameStack.ts`): frames and standalone elements stack per page by `frames.z`
  (nullable double, migration `0043_frame_stack`; unset stacks by `createdAt`), and `canvas.frames` is kept in that order, back
  to front, on the server and in the client store, so "topmost under a point" walks it backwards.
  A new frame lands in front of its page (a frame moved to another page too; undoing a delete
  passes its old `z`). The Layers panel lists the page front first, as Figma does: dragging a
  frame or standalone row between top-level rows (or onto the list's tail, the back) and ⌥↑/⌥↓
  restack it through `restackFrame` (`PATCH /api/frames/:id { z }`, one undo step), with a `z`
  halfway between the new neighbours, renumbering the page when doubles run out of room. An
  element dropped between root rows is lifted out through `stackRoom` + `detachLayer`: a
  renumbering the drop needed is saved first and rides in the detach's own undo step (a
  `stack` entry leading the `transfer`), or stands as its own step when the lift is called off.
  `Stage.tsx` mounts frames in creation order and paints them by `z-index` inside an isolated
  layer, since moving an iframe in the DOM reloads it. Tests: `frameStack.test.ts`,
  `frameStackStore.test.ts`, `layersStack.test.tsx`.
- Page background (`shared/pageBackground.ts`): a page may carry `background` (`#rrggbb`),
  kept across page-list saves the way `startFrameId` is and copied with the page and the
  canvas; `PUT /api/canvases/:id/pages/:pageId/background { color | null }` (edit role) and MCP
  `set_page_background` set it, peers get the page list. `PagePanel.tsx` is the page's own
  settings in the properties slot: with nothing selected, the rail's sliders icon opens it
  (`pagePanelOpen`, kept until closed) in place of the frame Inspector, as Figma's Design panel
  shows "Page" then; its Background `ColorField` edits the active page, one undo step
  (`page-background` history entry).
  `src/lib/paper.ts` resolves the paper a page shows (its colour, else the theme) and its tone;
  `Stage` paints it with contrast dots and a standalone drawing takes its ink from that tone.
  Tests: `pageBackground.test.ts`, the background cases in `storePages.test.ts`, `pages.test.ts`
  and `guideEdits.test.ts`.
- Selection keys (`src/lib/selectionKeys.ts`, chords in `src/lib/keys.ts`), as Figma binds them: ↩
  goes into the selected frame or element (its first layer), ⇧↩ back out to the parent (a root
  layer's parent is the frame; a standalone shape has none), Tab / ⇧Tab to the next or previous
  sibling (frames walk the page's stack the way the Layers panel lists it, wrapping), ⌘A takes
  every unlocked frame on the page or every unlocked sibling of the picked element
  (`store.pickElements`), and ⌘] / ⌘[ step the picked elements, together, or the selected frame
  forward or backward, ⌘⌥] / ⌘⌥[ to the front or back (`reorderElements` / `reorderLayers`,
  `restackFrame`), one undo step each. A picked standalone shape is its page's row: Tab, ⌘A and
  the brackets treat it as a frame, and ⌘A skips stack-locked shapes (`isStackLocked`). ↩ and Tab act only when no control has the keyboard (`isControlTarget`) and
  something is selected, so buttons, menus and the Layers tree keep theirs. The bracket chords are
  read by `code` too, since ⌥ changes the typed character on macOS. Tests: `selectionKeys.test.ts`.
- `src/lib/tools.ts` defines bottom-toolbar tools and shortcuts. `Stage.tsx` delegates drawing
  gestures and world-space previews to `CanvasDrawing.tsx`; Space/middle-button panning takes
  precedence over drawing.
- `src/lib/drawing.ts` creates rectangles, circles, straight and cubic Bézier SVG paths, text and empty
  frames through the existing frame API. Drawing inside a frame appends a positioned HTML/SVG
  layer. Standalone elements use frame persistence with a `data-doop-canvas-element` body marker
  for transparent canvas chrome; no separate shape schema or protocol is required. Pasted and
  dropped images (`src/lib/frameClipboard.ts`) are standalone elements too: one
  `<img data-doop-drawing="image">` named after its file. A standalone text or path takes its ink
  from the theme the person drew under (`drawingInk`: the dark theme's `--ink`, else `DRAWING_INK`),
  since it sits on the canvas paper; inside a frame the dark ink stays. The Layers
  panel shows one as a single layer at the root (no frame row, no name label on the canvas) and
  its rows drag between frames and the root: a drop on another frame's row moves the element
  there (`transferLayer` in `src/lib/layerEdits.ts`, removing a standalone's shell), a drop on
  the band above a root row or the list's tail lifts it onto the canvas at its rendered spot
  (`detachLayer`, measured through the frame bridge). On the canvas a standalone element moves
  through the frame drag (live, snapping, one undo step) and, let go over a frame, goes into it
  through `moveDrawing`. A layer leaving its frame takes the CSS it
  relies on along (`src/lib/styleCarry.ts`: the matching rules, their keyframes, font faces and
  custom properties, as one `<style data-doop-carried>`, every rule scoped through a
  `data-doop-carried-scope` mark on the moved root so the destination's own layers keep their
  look); copy/paste across frames carries it the same way. Tests: `layerTransfer.test.ts`, `layersDragAcross.test.tsx`, `styleCarry.test.ts`.
- The pen snaps to the nearest anchor on its unfinished path within eight screen pixels,
  highlights the target, and previews a closed curve when approaching the first anchor.
  Alt bypasses snapping. Double-clicking a native path opens `PathEditor.tsx`: anchors and
  Bézier handles can be dragged, and points can switch between corners and curves or be deleted.
  Drawing and editing use 0.75px guide strokes, 5px anchor markers and 4px handle markers at every
  zoom. Invisible 18px editing targets keep the smaller markers easy to grab.
  Each completed edit is one undo step. Alt moves a handle independently; Shift constrains
  its angle. `pathEditing.ts` reads existing line/cubic SVGs, preserves their affine transforms,
  resizes standalone bounds, and refuses to overwrite a concurrently changed path. The editor
  overlays the world canvas while the iframe hides the original through a transient marker.
  It refreshes geometry from the latest store state after saves, undo/redo, and remote changes,
  so an undo issued while a save finishes cannot leave stale anchors in the editor.
  Selecting an anchor or handle does not edit it until the pointer moves two screen pixels.
  Path saves send `expectedUpdatedAt` to the frame PATCH route. The server checks it synchronously
  before writing and returns HTTP 409 with the current frame on a conflict; the editor reloads
  that version without recording an undo step. Frame timestamps advance monotonically, even
  for multiple writes in the same millisecond, so concurrent saves cannot share a version.
  Delayed HTTP save responses cannot replace a newer frame received through the room.
- Saves are serialized, tracked by undo/redo, and scoped to the originating canvas/page. Each
  completed gesture has its own undo entry. The Layers panel shows the drawing's `data-name`.
  Completed saves survive navigation; unfinished drafts are cancelled. Drawing shortcuts leave
  native fields and rich-text editors alone, except for the drawing textarea's keys: ⌘/Ctrl+Enter,
  Esc and a blur all commit the typed text (an empty draft is dropped).
- `ElementMove.tsx` renders an unclipped drawing preview and highlights the destination frame.
  Ordinary HTML/SVG layers move in place through the runtime's geometry/style gesture bridge,
  preserving layout and transforms and committing one undo step per drag.
  The iframe runtime hit-tests the pointer in browser paint order and measures CSS layout
  size separately from transformed bounds. Pending pointer events are buffered until its
  reply, so fast drags and cancellation remain reliable. `src/lib/drawingMove.ts` preserves markup and translates coordinates when
  moving drawings into, between, and out of frames. Transfers save the destination before
  removing the source and use one undo entry; a failed prerequisite leaves the original intact.
  Rollback keeps a detached copy if its content, name, geometry, page, or flags changed after creation.
- A selected element inside a frame is dressed the way Paper draws a selection: a one-pixel
  outline, a square grip in each corner, grabbable unmarked edges, and a `W × H` badge underneath
  (`ElementResizeHandles.tsx`; geometry in `src/lib/elementResize.ts`). A drag opens the runtime's
  style gesture (`styleGesture` begin / commit / cancel in `frameBridge.ts`), previews inline
  `width` / `height` in the live document on every move and commits once on release as a discrete
  undo step, the same properties the Design panel's Size fields write. Pulling a west or north
  side outward still grows the box (flow layout places the element; the drag changes its size,
  never its place). Deltas are measured from the computed size, so a content-box element keeps
  its padding, divided by the element's render scale, and re-anchored while a pinch owns the
  finger. Shift keeps the aspect ratio (letting go puts the other axis back); Esc, or the grips
  leaving mid-drag, cancels. The runtime's hit info carries `sizable` and `locked`, so inline
  text runs, rotated or skewed elements, locked layers, locked frames and the Comment tool get no
  grips. `tests/elementResize.test.ts` covers the geometry and `tests/elementResizeBrowser.test.ts`
  drags the grips in Chromium.
- A selected frame wears the same furniture as a selected element (`FrameResizeHandles.tsx`,
  geometry in `src/lib/frameResize.ts`): a grip in each corner, grabbable edges, a two-pixel
  ring, all in screen px at every zoom, and a `W × H` badge under the frame in the label layer.
  A west or north pull moves that edge and keeps the far one still; Shift keeps the ratio; the
  dragged edges snap to neighbours and guides (`snapFrame` takes the handle). Frames go down to
  1×1 (`MIN_FRAME_SIZE`, also the Inspector's floor). `tests/frameResize.test.ts` covers the
  geometry, `tests/frameResizeBrowser.test.ts` drags the grips in Chromium.
  The frame Inspector's X / Y / W / H are the same `NumberField` the element panel uses
  (`src/components/ui/property-field.tsx`): the `px` unit is the drag handle (`useValueScrub`,
  Shift ×10, Alt ×0.1, Esc cancels) and ↑/↓ nudge. A drag previews every step through
  `patchFrameLocal` and, through `PropertyScrubContext`, commits once on release as one discrete
  undo step and one PATCH; Esc puts the frame's box back and saves nothing. Tests:
  `inspectorScrub.test.tsx`.
- Rulers and guides (`src/components/Rulers.tsx`, math in `src/lib/rulers.ts`): ⇧R or the zoom menu
  toggles `<canvas>` rulers docked on the stage's top and left edges (the top bar and the floating
  chrome step in by `RULER_PX`) (remembered under
  `doop:rulers`, hidden on phones and under ⌘.). Ticks step 1/2/5×10ⁿ by zoom; labels count from the
  selected frames' top-left, whose extent is highlighted. Dragging out of a ruler adds a guide;
  guides drag, drop back on their ruler or Delete to remove, and undo/redo (`history.ts` `guide`
  entries). Guides live in `canvases.guides` (jsonb, per page, client-generated ids), written one
  at a time through `PUT`/`DELETE /api/canvases/:id/guides/:guideId` behind `requireCanvas` and
  broadcast as `guide` room messages; page copies and canvas copies take them along (within
  `MAX_GUIDES`), a deleted page drops its guides and page undo/redo puts them back. Writes to
  one guide run in order, and a failed one rolls back only when no newer edit follows. Visible
  guides join `snapFrame` (frame move/resize, element moves), element resize and drawing points
  at the same 8-screen-px tolerance; Alt bypasses. Tests: `rulers.test.ts`, `snapGuides.test.ts`,
  `guides.test.ts`, `guideEdits.test.ts`, `rulersBrowser.test.ts`.
- SVG import (`src/lib/svgPath.ts`, `src/lib/svgImport.ts`): an SVG pasted, dropped or pasted as
  markup lands as editable vector layers, not an `<img>`, the way Figma imports one. Every
  `path`/`rect`/`circle`/`ellipse`/`line`/`polyline`/`polygon` is baked (transforms, nested
  `viewBox`es, `<use>` and `<symbol>` expanded, the whole `d` grammar including arcs and
  quadratics turned into absolute cubics) into one `svg[data-doop-drawing="path"]` with a single
  `path` child; `<g>` nesting becomes `div[data-doop-drawing="group"]` rows; text and images stay
  as `svg[data-doop-drawing="svg"]` layers; gradients, clips, masks and filters ride in a
  `[data-doop-defs]` host with the import's id prefix, user-space gradients and clips copied with
  the shape's transform folded in. Paint comes from the browser's computed styles
  (`importSvgInBrowser` mounts the file in a closed shadow root, so `<style>` rules, classes and
  `currentColor` resolve and leak nowhere); `importSvgMarkup` reads attributes alone for tests.
  Scripts, handlers and `foreignObject` are dropped. The element's shell is the ink's box; layers
  sit in it by percentage so the shell's grips scale them. A one-shape file is a bare pen-style
  path. Entry points: `splitIncoming` / `pasteFilesCentered` / `dropFiles` in
  `src/lib/frameClipboard.ts`, wired in `CanvasPage`'s paste and drop: bitmaps and vectors brought
  together land in one row (a vector keeps its proportions, a bitmap gets at least a 40px box) and
  whatever lands is one undo step even when a sibling request fails. Shape lengths resolve their
  units and percentages (`parseLength`, against the nearest `viewBox`); transforms come from the
  style reader (a stylesheet's `transform` wins) about `transform-origin`; the root's own
  opacity, clip, mask and filter stay on the root group, a group's mask and filter on its row, and
  copied definitions (gradient stops, clip shapes) keep the styles they resolved. A clip or mask
  drawn in user units gets a copy carrying the transform baked into the shape it clips (`bakedClip`
  / `bakedMask`; a mask's content rides in a `<g>`, since `<mask>` takes no transform); one in
  bounding-box units is used as it is. A text or image layer keeps the `clip-path`, `mask` and
  `filter` its stylesheet gave it, and its own opacity goes on the layer's svg alone. Tests:
  `svgPath.test.ts`, `svgImport.test.ts`, `svgImportBrowser.test.ts`.
- PDF import (`src/lib/pdfImport.ts`, `src/lib/sfnt.ts`, proof of concept): a PDF dropped or pasted
  on the canvas lands as one frame per page at the page's printed size (points × 96/72). MuPDF's
  WebAssembly build (`mupdf`, AGPL, a lazy 10 MB chunk excluded from Vite's pre-bundling so it finds
  its `.wasm` by `import.meta.url`) reads the file in the browser. Each page is rendered to SVG in
  CSS px with its text stripped and run through `importSvgInBrowser` with `box: 'root'` (the page is
  the box, since clipped backgrounds reach past it) and a raised layer budget, so paths, gradients,
  clips and images become the same editable layers an SVG gives; a CMYK JPEG is decoded through the
  page and re-encoded as RGB, and in the browser every picture becomes an `/a/` asset. The text comes
  from MuPDF's structured text (ligatures kept), one `<p data-doop-drawing="text">` per run of one
  font, size and colour, placed by the glyph box, rotated runs turned about their first glyph.
  Fonts are keyed by font object, not name: a producer embeds several subsets under one name
  (InDesign, per page), so a page's font resources (Form XObjects included) are paired with each
  object by name and, where several programs share it, by comparing FreeType's advances for the
  glyphs shown. The program is then completed into a loadable OpenType file: `sfnt.ts` adds the
  `OS/2`, `name`, `post` and Unicode `cmap` tables a PDF subset drops (the cmap from the glyphs the
  page drew, ligature glyphs voted out of the plain letters), wraps a bare CFF program (`Type1C`,
  CID-keyed charsets inverted) with synthesised `head`/`hhea`/`hmtx`/`maxp`, and the browser's own
  `FontFace` check drops anything it still refuses. Faces ride in the frame as `@font-face` data
  URIs named `pdf-<BaseFont>`; Type1 programs and unembedded fonts fall back to the spaced family
  name over a generic from the descriptor flags, with weight and style synthesised. Not yet:
  paragraphs (every run is its own line), fonts as library assets instead of data URIs, an
  Import-picker card, a static-image fallback for scans and a progress indicator. Tests:
  `pdfImport.test.ts` (fixture `tests/fixtures/pdf/report.pdf`, a Chrome-printed page with five
  embedded subsets), the page count in `imagePaste.test.ts`.
- The path editor (`PathEditor.tsx`, `src/lib/pathEditing.ts`) edits any `d` the parser reads,
  compound paths included (`EditablePath.subpaths`; anchors are numbered flat across strokes);
  clicking the outline splits the segment there (`splitSegment`, a line stays linear in `t`);
  deleting the last-but-one anchor of a stroke removes the stroke when others remain. The runtime's
  `doop:path` probe finds a shape inside an imported group (no standalone-root collapse) and
  reports `parentBox`; `updatePathFrame` keeps a grouped shape in percentages of its group and
  grows the group (the standalone's frame, or the root's px box inside a frame) around a point
  dragged past its edge, re-placing the sibling shapes. Cursors follow Figma's (`cursor-pen*`,
  `cursor-node`, `cursor-handle` utilities in `src/styles.css`, each SVG tagged `data-cursor`): the
  Path tool wears the nib, with a ring over the first anchor (close) and a square over one it
  already placed (`penCursor` from `useCanvasDrawing`, forced over frames by `Stage`); the editor
  shows a node badge on anchors, a dot badge on handles and the pen with + on the outline.
- `tests/drawing.test.ts` covers geometry, serialization and persistence; `drawingBrowser.test.ts`
  exercises the toolbar and gestures in Chromium, including Bézier paths, frame transfers,
  cancellation, mobile input, and coexistence with canvas comment pins and reply fields.
  `tests/drawingMove.test.ts` covers transfer persistence, locks, failed saves and rollbacks,
  creation queued with transfers, and undo/redo. Browser regressions cover transformed shapes,
  stacking contexts, covered shapes, and delayed hit-test replies.

- Comment anchors (`shared/comments.ts`): an element comment is `frameId` + `elementId` (the
  element's `data-doop-id`) + `snippet`; a frame comment is `frameId` + design-px `x`/`y` and no
  `elementId`; a canvas comment is `pageId` + world `x`/`y`. One whose element is gone keeps the
  frame and snippet only and is listed without a pin. The browser still sends the runtime's
  positional selector (plus `elementId` when the element already wears one, and always the
  point); the server stamps and stores the id. `FrameView` places pins by
  `doop:locate` on `[data-doop-id="…"]`. Comments stored before element ids carry their old
  selector in the `selector` column, which `actions.backfillElementIds` resolves once after the
  server starts listening, frame by frame with awaited, ordered writes (the stamped frame, then
  the comments naming its ids); unresolvable paths become lost anchors, a row that throws or a
  frame write that fails is logged and left for the next boot. Tests: `elementIdBackfill.test.ts`.
- Agents answer in the thread (`server/resident.ts`): a resident run about `@mentioned` comments
  posts its closing summary as the agent's reply in each thread (one message per thread) before
  resolving it, and a failed run posts the reason and marks the comment failed for a retry
  (`settleComments`). The kickoff lists each comment's id, and the resident has
  `reply_to_comment` and `resolve_comment` as tools (`replyInThread`: this canvas only, never
  metered, a resident `@mention` in the agent's words becomes a plain name through
  `withoutMentions` so it cannot queue itself); a thread the agent answered itself gets no
  second reply from the summary. A question the agent needs answered first is
  `reply_to_comment` with `awaiting_answer`: when the run ends the request is handed back
  (`actions.handBackComment`: unclaimed, no longer an agent item in memory and in its row, the thread open), so the
  person's `@mention` answer queues fresh work carrying the whole conversation. MCP agents have
  had the same two tools all along. Tests: `residentComments.test.ts`, `agentToolParity.test.ts`.
- Comment pins move by drag (`src/lib/commentMove.ts`, gesture in `CommentPin`): anyone who may
  comment drags a thread's root pin; a ghost rides the pointer in the world layer
  (`CanvasComments`), above every frame, since the pin itself sits inside a clipped frame surface.
  On release the drop point is resolved in order: the topmost visible frame under it is probed
  (`doop:probe`) for an element, else the frame as a whole at that design point, else the canvas
  at that world point, so a thread changes kind either way (element → canvas comment and back).
  `PATCH /api/comments/:id/anchor` (comment role; `CommentAnchorInput` in `shared/comments.ts`)
  re-anchors the root and its replies together and broadcasts each; a drop on the same anchor
  sends nothing, Esc mid-drag puts the pin back. Tests: `commentMove.test.ts`,
  `canvasCommentsRoute.test.ts`, `elementIds.test.ts`, the drag case in `drawingBrowser.test.ts`.
- Prototypes (`.context/specs/prototyping.md`): interactions are `data-doop-on` /
  `data-doop-action` (or the JSON `data-doop-interactions`) attributes in frame HTML, parsed by
  `shared/prototype.ts`, whose parser the frame runtime inlines by source. `PrototypePlayer.tsx`
  (Play, and the full-page `/c/<id>/proto`) runs them with Web Animations transitions, under the
  desktop tab strip (`--app-inset`), scaled by the viewer's pick (actual size, responsive, fit width,
  fit, fill; `screenLayout`, remembered under `doop:proto-scaling`); the
  Prototype tab and `PrototypeOverlay.tsx` edit and draw them; MCP has `get_prototype` and
  `set_prototype_start`. `tests/prototypeBrowser.test.ts` drives the player in Chromium.

## 5. Security and Secrets

- better-auth 1.6.26 - authentication: email/password, generic OIDC/SSO, and Google / Microsoft /
  Apple sign-in (social providers, `GOOGLE_*` / `MICROSOFT_*` / `APPLE_*` client pairs; the iOS app
  signs in with Apple natively against `APPLE_APP_BUNDLE_IDENTIFIER`). Configuration and secrets
  (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, provider client IDs/secrets) come from the
  environment (`.env`, documented in `.env.example`); never committed.

- Credentials kept for users are encrypted at rest (`server/secretBox.ts`): `sealedText` columns
  in `server/db/schema.ts` (model-account keys and tokens, integration and GitHub tokens,
  Linear/Slack installs, webhook secrets) are AES-256-GCM sealed on write and opened on read, so
  call sites see plaintext. Keys come from `SECRETS_ENCRYPTION_KEYS` (`id:base64`, first one
  active; dev and tests use a built-in key, unset in production stores plaintext and warns). After
  boot `resealSecrets` (`server/secretBackfill.ts`) seals legacy plaintext and re-seals rows under
  a rotated-out key. Never filter on a sealed column; each write uses a fresh IV. better-auth seals
  social sign-in tokens itself (`account.encryptOAuthTokens`). Sync-key secrets, APNs tokens and
  MCP OAuth tokens stay plaintext (looked up by value). Tests: `secretBox.test.ts`.

- Reading a failed auth call (`src/lib/authError.ts`): only our own API sends a string
  `error.code`, so `authErrorCode` is what `AuthPage.tsx` matches on and `authErrorMessage`
  is what it shows. Railway's edge answers in its own shape whenever it cannot reach the
  container (every deploy restart) — `status`, a NUMERIC `code`, `message`, `request_id` — and
  better-fetch spreads that body into `error`, numeric code and all, so a code match that called
  a string method on it threw inside the submit handler and left the form silent. A code that is
  not a string matches nothing, and such a message (`Application failed to respond`) becomes a
  plain try-again rather than being shown. Tests: `authError.test.ts`,
  `authFormBrowser.test.ts` (the real form in Chromium, against that exact edge body).

- MCP OAuth (better-auth `mcp()` plugin): 1h access tokens, 30-day refresh tokens
  (`MCP_REFRESH_TOKEN_TTL_S` in `server/mcpTokens.ts`; the plugin neither rotates nor revokes
  them). A daily prune deletes expired token rows but keeps the newest per user and client,
  since `allowance.ts` reads any row as proof an agent once connected.

## 6. Build and Dependency Management

- Canvas access: `canvasRole` in `server/access.ts` gives owners, members and workspace members
  edit, and share-link visitors the link's level (`none` / `view` / `comment` / `edit`). REST,
  the WebSocket room and MCP gate reads, comments and writes on it separately; spec in
  `.context/specs/share-link-roles.md`.

- Bun 1.3.10 - package manager; lockfile at `bun.lock`, installed with `bun install
--frozen-lockfile` in CI.
- Vite 8 (Rolldown-based) - frontend build tool (`vite build`), with `@vitejs/plugin-react` 6.

## 7. Testing Stack

- Vitest 5 - unit/integration tests across `server/` and `src/`; run via `bun run test`
  (`vitest run`). Tests live in `tests/`.
- Browser tests drive one shared Chromium and one Vite fixture server (`tests/browser.ts`), which
  `tests/globalSetup.ts` starts and warms (every `tests/fixtures/*.html` loaded once) before any
  worker runs; a file calls `openBrowser()` for its own context (focus emulated, 30s navigation
  bound) and `fixtureUrl()` for its page. A test that needs its own Vite server (a proxy) builds it
  from `fixtureServerConfig()`, so every server shares one dependency hash and cache directory.

## 8. CI/CD and Delivery

- GitHub Actions:
  - `.github/workflows/ci.yml` - gates `typecheck`, `lint` + `format:check` + `doc-lint`, `build`
    and `test` (four vitest shards) as parallel jobs on push to `main` and on PRs, cancelling
    superseded PR runs; a separate job lints the PR title with commitlint (PRs land on
    `main` as a squash, so the PR title becomes the commit subject).
  - `.github/workflows/cla.yml` - CLA check (this is an AGPL-3.0 project with CLA-based
    contribution).
  - `.github/workflows/desktop.yml` / `desktop-release.yml` - Tauri desktop app CI and installer
    release (tag `desktop-v*`, universal macOS DMG, Windows NSIS, Linux AppImage/.deb/.rpm,
    optional Apple signing/notarization).

## 9. Infrastructure and Deployment

- Experimental Gemini cloud pilot: `server/geminiCloudRuns.ts` dispatches resident harness tasks
  to per-user workers; `server/geminiCloudMcp.ts` exposes run-scoped canvas tools. The standalone
  worker runs official Gemini CLI headlessly, with Google credentials retained in its own volume.
  `workers/gemini/Dockerfile` builds the worker. Setup and limitations: `docs/gemini-cloud-pilot.md`.
  `DOOP_GEMINI_CLOUD_WORKERS` enables operator-managed routing and BYO metering; unset by default.

- Docker - `Dockerfile` + `docker-compose.yml`; `docker compose up` runs the app container
  (port 4400) and a `postgres:16-alpine` db container for self-hosting.

## 10. Frontend Stack

- React 18.3.1 + Vite 8 - SPA, entry at `index.html`.
- Tailwind CSS 4.3.3 (`@tailwindcss/vite` 4.3.3) - styling; `tw-animate-css` 1.4.0 for animation
  utilities. Design tokens in `src/styles.css` (see `.context/DESIGN.md`).
- Tauri 2.9.0 (`@tauri-apps/cli`, `desktop/src-tauri`) - desktop app wrapper around the web build.
- Interface language (`src/lib/i18n/`, no library): English (`en/`, the source catalog, one
  `as const` namespace per area) and Brazilian Portuguese (`pt-BR/`, typed `Catalog`, so a missing
  key fails typecheck). Components call `useT()` and `t('namespace.key', vars)`; `{name}`
  placeholders are type-checked, `{ one, other }` values pick a plural by `{count}`, and a key kept
  in a table is a `PlainMessageKey` translated at render. The active language is this browser's pick
  (`doop-locale` in `localStorage`, Settings -> Appearance or the account menu), else the server's
  `DEFAULT_LOCALE` (`GET /api/locale-config`, asked once before React mounts), else `en`; the list
  lives in `shared/locales.ts`. `tests/i18n.test.ts` checks every catalog against English. Screens
  not yet converted still render English.
- Home (`src/pages/Home.tsx`, `src/components/HomeHero.tsx`): a 12.5px rail (canvases, workspaces,
  explore, resources, agents, an Ask Doop pill bound to ⌘/), Import + New canvas in the top bar, and
  a hero over the brand's gradient wave: the hopping Disc-D, a greeting, a strip of suggestion chips
  (the "on" chip wears the drifting colour beam from `src/styles.css`) and a composer. A prompt makes
  a canvas named after it (`src/lib/homePrompt.ts`), queues it as the first board card asking for N
  drafts, and opens the canvas; a card that cannot queue rides along as the canvas composer's draft.
  The hero's top-right close button asks to "Hide Prompt Box" before hiding the whole prompt area.
  `src/lib/homePreferences.ts` remembers the choice in this browser under `doop.home.prompt-box-hidden`;
  Settings → General → Show Prompt Box restores it. The preference also updates other open tabs.
  Import makes a canvas and opens it with `?import=1`, which `CanvasPage` turns into the import
  picker. `GET /api/canvases` adds `people` (owner, then members) for the tiles' avatar stacks.
  The rail is `src/components/AppRail.tsx`, mounted by Home, Automations, Integrations, Community,
  Workspace and Admin alike (a page's own group, such as a workspace's panes, goes in as children;
  Settings draws its own rail from the same `ui/dash.tsx` parts); it owns
  the ⌘K search palette (`CanvasSearchModal.tsx`), the connect-an-agent modal, the collapsed
  narrow state (remembered in `localStorage` under `doop-rail`) and the account face at the bottom.
  From another page the rail sends scope picks home as `/?scope=` and new workspaces as
  `/?workspace=new`.

## 11. Developer Experience Tooling

- oxlint 1.x + oxlint-tsgolint (type-aware rules) - lint, config in `.oxlintrc.json`; ESLint 10 with
  the typescript-eslint parser runs only the `process.env` ban in `eslint.config.js`.
- Prettier 3.9.6 - formatting (no semicolons, single quotes, printWidth 120), config in
  `.prettierrc.json`.
- Husky 9.1.7 + lint-staged 17.3.0 - pre-commit hook runs `lint-staged` (`.husky/pre-commit`).
- commitlint 21.2.2 (`@commitlint/config-conventional`) - conventional commit / PR title linting,
  config in `commitlint.config.js`.

## OSS integration scope

The integration registries currently register Linear only. Canvas imports offer websites, live-app
sync and GitHub repositories; frame exports offer PNG/JPG with progress feedback and desktop saving.
Figma, Canva and PSD are deferred. Migration 0019 is reserved for the deferred Figma integration;
the OSS journal skips it while retaining the shared migration tags and timestamps for 0020–0022.
Gemini cloud workers remain an operator-managed, opt-in pilot; see `docs/gemini-cloud-pilot.md`.

The shared font library serves public font assets with CORS so sandboxed frames can load them.
Migrations 0040 (agent feedback) and 0041 (custom fonts) retain their shared timestamps; their OSS
snapshots omit the deferred Figma `integrations.refresh_token` column, as does the credential
encryption backfill. Desktop downloads use the platform-neutral `https://doop.design/download` page.
