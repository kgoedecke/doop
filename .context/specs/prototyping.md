# Clickable prototypes

Frames become a clickable flow: an element says what happens when it is clicked (or hovered,
pressed, keyed, or after a delay), the player runs those interactions full screen, and the editor
wires them up visually. Code: `shared/prototype.ts` (model, parser, canonical writer, HTML
scanner), `src/lib/frameProtoRuntime.ts` (triggers inside the frame), `src/components/
PrototypePlayer.tsx` (player), `src/components/InteractionsPanel.tsx` and `PrototypeOverlay.tsx`
(editor), `server/mcp.ts` (`get_prototype`, `set_prototype_start`).

## Data model

Interactions live in the frame HTML as data attributes on the element that triggers them. They
persist, sync, version and export with the frame, and agents author them with the ordinary HTML
tools; there is no interaction table or protocol message.

| attribute              | values                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `data-doop-on`         | `click`, `hover` (pointer enters), `press` (pointer down; release reverts), `delay:<ms>` (after the frame is shown), `key:<Key>` |
| `data-doop-action`     | `navigate:<frameId>`, `back`, `overlay:<frameId>`, `close-overlay`, `scroll-to:<css selector>`, `url:<http(s) url>` (new tab)    |
| `data-doop-transition` | `instant` (default), `dissolve`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `push-left`, `push-right`                |
| `data-doop-duration`   | milliseconds, default 300, capped at 5000                                                                                        |

`key:` takes a `KeyboardEvent.key` (`ArrowRight`, `Escape`, `Enter`; `Space` means the space bar).
Several interactions on one element use the JSON form,
`data-doop-interactions='[{"on":"click","action":"navigate:abc","transition":"dissolve"}]'`
(`on`, `action`, optional `transition` and `duration`). An element may carry both forms; the
single form is read first. `parseInteractions` drops every invalid entry rather than repairing it:
an unknown trigger, action or frame-id shape, a `url:` that is not http or https. Unknown
transitions and bad durations fall back to the defaults.

**Canonical form** (what the editor writes, `interactionAttributes`): one interaction is the
single-attribute form, with transition and duration omitted at their defaults; two or more are
the JSON form. A write removes every attribute of the other form, so an edited element never
carries both.

**Flow start.** `CanvasPageInfo.startFrameId` names the frame a page's flow starts on (one per
page). It is set only through `PUT /api/canvases/:id/pages/:pageId/flow-start` (`{ frameId |
null }`) or the `set_prototype_start` tool; page-list saves (`PUT .../pages`, `set_canvas_pages`)
keep the server's value. Without a start, or when the start frame is gone, the flow starts on the
page's top-left visible frame (`flowStartFrame`).

**Inert outside the player.** The frame runtime ignores the attributes until the parent sends
`doop:proto { on: true }`, which only the player does; text-edit mode also suppresses them. On the
canvas a click therefore still selects. The attributes have no effect on PNG/JPG/PDF exports.

## Player

`PrototypePlayer` evolves `PresentMode`: the frame fills the viewport letterboxed and scaled to
fit, and stays live (each screen re-posts its frame's HTML when the store updates it).

- Each screen boots the frame runtime, renders the HTML, then turns prototype mode on. Triggers
  post `doop:proto-action` with the parsed interaction; the player re-parses it
  (`sanitizeInteraction`) before acting, since a frame script could post anything. `scroll-to`
  runs inside the frame (from a press too); `url` opens a new tab with `noopener`. A live edit
  restarts the screen's `delay:` timers from the new HTML.
- Navigation keeps a history stack (each visit a fresh document, at most 50). A move mounts the
  target beside the current screen, waits for it to render, then animates the two wrappers with
  the Web Animations API (`transitionFrames`). `back` plays the arriving transition in reverse.
  A navigation during a running animation snaps it to its end.
- Overlays open centered over a scrim at the base screen's scale (fit to 94% of the viewport).
  The scrim or a `close-overlay` closes the top one; navigating closes them all.
- `press` reverts (closes the overlay or goes back) on the next pointer release in any screen,
  while what it opened is still on top. The pressed screen reports that release even after the
  navigation has switched it off.
- Keys go to the topmost screen's runtime. Escape, wherever the focus is (a screen relays it as
  `doop:esc`), closes an open overlay, else runs the screen's `key:Escape` interaction, else exits the player when it was opened over the editor. While the
  player is open no key reaches the editor.
- A click that hits no interaction flashes every hotspot of that screen (as Figma's hotspot
  hints do); the toolbar's hotspot button flashes them on demand. The toolbar also has Back,
  Restart, open-in-new-tab and Exit.

Entry points: the editor's Play button starts on the selected frame, or on the page's flow start
with nothing selected. `/c/<canvasId>/proto[?frame=<id>|?page=<id>]` (`PrototypePage`) is the
shareable full-page player. It joins the canvas room like the editor, so the server's
`canAccessCanvas` gate decides who may open it, and each navigation is a browser history entry,
so the browser's Back and Forward walk the flow. Each entry's state records its frame and depth
(the opening entry included, whatever its URL), and `historyStep` turns a popstate into a reversed
Back or a jump by depth, so a flow that repeats a screen walks back and forward correctly.

## Editor

The top bar's Prototype toggle and the element panel's Prototype tab are the same mode
(`store.prototypeMode`).

- **Interactions** (Prototype tab): the picked element's interactions, each with trigger, action,
  target (a frame picker over every frame on the canvas, a selector or a URL), transition and
  duration. Each change rewrites the element's attributes through `saveFrameHtml`, one undo step.
  Locked layers and frames are read-only; script-created elements, which have no markup, say so.
  The Flow row makes the frame its page's start.
- **Connectors** (`PrototypeOverlay`, world space): every live frame on the page reports its
  hotspots through `doop:proto-scan` (script-created ones included); each interaction that opens
  a frame on the page gets a connector into that frame, others a short label (Back, Close
  overlay, scroll target, link, a frame on another page, or a missing frame). The start frame
  wears a Start flag.
- **Drag to connect**: the picked element has a handle on its right edge; dropping it on another
  frame replaces the element's click-navigation with one to that frame (one undo step).

## Agents

`PROTOTYPES` in `server/guide.ts` documents the attributes; it is the guide's "Prototypes"
section and part of the resident agents' system prompt. `get_prototype` lists each page's start
and every interaction, flagging targets that are not on the canvas; `set_prototype_start` sets or
clears a page's start and rejects unknown frames and frames on another page. Both are implemented
once in `server/prototypeTools.ts` and exposed over MCP and to the resident agents (which pass an
empty `frame_id` to clear). `tests/agentToolParity.test.ts` holds the resident tool set to the
MCP server's: every MCP tool is a resident tool, an equivalent, covered by the run's context, or
a listed gap.

## Tests

`tests/prototype.test.ts` (parser, canonical form, scanner, flows, editor writes, player
helpers), `tests/prototypeMcp.test.ts` (tools), `tests/prototypeBrowser.test.ts` (player
navigation, back, overlays, live edits, hotspot flash, Escape, connectors, inert edit mode) and
`tests/interactionsPanelBrowser.test.ts` (Prototype tab editing with undo).
