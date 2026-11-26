# TECHSTACK - doop

## 1. Language and Runtime

- TypeScript 5.9 (strict mode) - primary language across `server/`, `src/`, and `shared/`.
  `bun run typecheck` uses `tsgo` (`@typescript/native-preview`, the TypeScript 7 Go compiler) for
  speed; the JS `typescript` package serves editors and the ESLint parser.
- Node.js 26 LTS - runtime, pinned in `.node-version` (and `engines`, the Dockerfiles, CI and the
  self-hosted runner image). Node runs the server's TypeScript itself by stripping types, with no
  build step or loader: `node --watch server/index.ts` in dev, `NODE_ENV=production node
server/index.ts` in prod. `erasableSyntaxOnly` and `verbatimModuleSyntax` in tsconfig keep the
  source strippable (no parameter properties or enums; `import type` for types).
- Bun 1.3.10 - pinned via `packageManager` in `package.json`; used as the package manager and
  script runner, not as the server runtime.
- Rust (stable) - `desktop/src-tauri`, the Tauri desktop shell, and `desktop/src-tauri-chromium`,
  the same sources built on Chromium (CEF) for the macOS app.

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
  Nor is it an edit: `updatedBy` stays the design's last author and `updatedAt` moves one step past
  the version before, not to now (`store.updateFrame`), so a save made against the older version is
  still a conflict, while agents reading `updatedBy`/`updatedAt` for who is mid-edit are not told a
  commenter just edited the frame. Every annotation writer (stamps, token and theme renames,
  component markup written out again) files it so.
  A positional path that does not resolve in the saved HTML (a script-made element, a frame
  mid-stream) is refused, and a comment falls back to the frame at its point. The frame runtime's
  probe reports an existing id as `elementId`; its positional `cssPath` is now only the editor's
  internal selection language.
- Element links use `/c/<canvasId>?frame=<frameId>&element=<data-doop-id>` (no selector form,
  and no backwards compatibility for the old one). `src/lib/elementLink.ts` owns copying from the
  element menu and Layers menu, stamping first when the element has no id; `Stage.tsx`
  focuses its page and frame; `FrameView.tsx` resolves the id in the ready iframe, including
  script-created elements, re-picks the positional path so the Layers panel follows, and falls
  back to frame details if nothing carries the id. Browser regressions in
  `tests/pageCanvasBrowser.test.ts` cover initial loading, cross-page links, stamping on copy,
  clipboard round trips, history and script-created or script-removed elements.
  Links inside a frame are followed with ⌘-click (Ctrl elsewhere) in Select (`resolveFrameLink`),
  every link the way a browser would take it: a link to a frame of the open canvas moves the camera
  there (`Stage.followFrameLink`), a page link switches to that page, `#id` scrolls the frame's own
  document (`doop:anchor`; a bare `#` to the top), and anything else opens in a new tab (a relative
  path against Doop's origin; the system browser in the desktop shell), `mailto:` and `tel:` in
  their app. Never followed: a scheme outside http(s), mailto and tel (`javascript:`, `data:`), and
  a link into this canvas naming a frame or page that is gone or hidden. Only while the chord is
  held does a followable link wear a hand cursor and a brand outline (`useLinkModifier`, the
  runtime's `linkRect`); a plain click still selects. The browser can show a frame document's own
  cursor through the shield (a link's hand), so the frame wears the surface's cursor (`doop:cursor`,
  the runtime's `vCursorSheet`) except while text is edited; the prototype player sends none, so a
  played design keeps its cursors. In a text edit, a click on nothing editable ends the edit as
  Escape does (not the click ending a text drag that let go past the text). Tests:
  `frameLinkTarget.test.ts`, the link case in `tests/pageCanvasBrowser.test.ts`, the cursor case in
  `richTextBrowser.test.ts`.
- Page links are `/c/<canvasId>?page=<pageId>` (`src/lib/pageLink.ts`, pure). `openingPageId` is
  the one rule for the page a canvas URL opens: the page of the frame it links, else the page it
  names, else the default (the first page; on a library canvas its components page, see Workspace
  component libraries). A frame or page that is not on the canvas counts as not named. The store's
  `setCanvas` applies it when a canvas is first opened, so the first paint is that page; a rejoin
  keeps the page the person is on. `followPageInUrl` (`src/lib/pageUrl.ts`, mounted by
  `CanvasPage`) then keeps the address bar on the open page with `history.replaceState`, as
  `?pane=` does on the Workspace page, so Back leaves the canvas rather than walking page
  switches: `pageSearch` drops `page` on the default page, leaves a frame link on the open page
  alone, drops a frame, element or comment link to another page, and keeps every other parameter.
  A history entry that names a page opens it. The URL is this browser's view: a remote page-list
  change moves nobody, except off a deleted page. "Copy link to page" is in the page row's menu
  (`PagesPanel.tsx`, viewers too; the link always names its page). Agents get the form in the MCP
  instructions, the guide's Pages bullet and the resident kickoff. Tests: `pageLink.test.ts`, the
  "pages in the URL" cases in `tests/pageCanvasBrowser.test.ts`.
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
- Icons and stock photos from Doop's origin (`server/hostedCopies.ts`, `server/iconProxy.ts`,
  `server/photoProxy.ts`): `search_icons` hands out `/icons/iconify/<prefix>/<name>.svg` and `search_images`
  `/photos/pexels/<id>.jpeg?w=&h=` (the provider in the path, so another source can sit beside it), which the server fetches from Iconify or Pexels the first time
  anything loads them and keeps in the bucket (`iconify/` and `pexels/<sha256 of the source URL>.<ext>`)
  and a small in-memory LRU. Only each source's known options pass (Iconify `color`, `width`,
  `height`, `rotate`, `flip`, `box`; Pexels `w`, `h`, `dpr`, `fit`, an unsized photo getting the
  940x650 search size, never the original), redirects are refused, and source fetches are capped
  (icons 16 running and 64 waiting, photos 8 and 32; past that a 503 with `Retry-After`). Served
  like an `/a/` asset (nosniff, open CORS, a script-free CSP on SVG; photos immutable). Hotlinks to
  `api.iconify.design` rendered blank in screenshots on and off, since the hosted renderer fetched
  them itself; the renderer (`loadFrameInto`) also points a frame's existing Iconify and Pexels
  hotlinks at Doop before loading it; `hostedIconSvg` and `hostedPhoto` read both in-process,
  since a private `BETTER_AUTH_URL` is refused by `fetchRemote`. Pexels' licence
  allows rehosting; arbitrary hotlinked images are never copied. Every frame write also points
  Iconify hotlinks (slash or colon form) at Doop (`withHostedIcons` in `withCanvasFaces`, and on a
  stream's healed partials) and starts fetching the copies two at a time (`warmHostedIcons`), since
  viewers' browsers loading a canvas full of hotlinked icons drew a 429 from Iconify and left icons
  blank until a reload. Tests: `iconProxy.test.ts`, `photoProxy.test.ts`, `iconFrameWrites.test.ts`.
- Where frame CSS goes (`FRAME_STYLES` in `server/guide.ts`): agents are asked to style an element
  in its own `style` attribute, which is what the editor reads and writes, and to keep a `<style>`
  block for what an attribute cannot say (keyframes, font faces, `:root` custom properties, states,
  pseudo-elements, media and container queries, a component's variant rules, the reset). A property
  a state, variant or query changes sits in the stylesheet with its resting value too, since an
  inline value outranks every rule. Guidance
  only: nothing rejects or rewrites a stylesheet, and a frame already styled by classes keeps them.
  The MCP guide, `create_frame`'s description and the resident agent's system prompt carry the same
  text. Tokens and components in the same guidance: the brief (`DESIGN_BRIEF`) creates the canvas's
  tokens before the first frame and keeps `save_decision` for the why behind a choice (never a copy
  of the values); `FRAME_STYLES` says to use `var(--…)` and never a frame's own `:root` palette;
  `COMPONENTS` says mains nest `<doop-use>` and the repetition rule holds inside them; the review
  checklist has a Reuse item. Tests: `frameStyleGuidance.test.ts`, `tokenComponentGuidance.test.ts`.
- Agent teams (`shared/customAgents.ts`, `server/customAgents.ts`, `server/customAgentRoutes.ts`,
  `src/components/CustomAgents.tsx`): the Doop Agent roster each workspace (Workspace → Agents) and
  each person (Settings → Doop Agent, for their personal canvases) has, the way font libraries split.
  The six built-in roles of `shared/agents.ts` can be switched off (Doop excepted: unaddressed work
  goes to it) or edited (colour, one-liner, instructions, reviewer flag; Reset undoes the edits and
  leaves on/off alone), stored per scope in `agent_overrides` with null for "as shipped". Custom
  agents are `AgentRole`s with `custom: true`: a fixed handle (its role id and its only @mention
  spelling) and name (its presence identity), editable colour, one-liner, instructions (up to 2,000
  characters) and reviewer flag, at most 20 per scope, in `custom_agents`. `scope` is `ws:<id>` or
  `user:<id>` in both tables (migration 0057), mirrored in memory. A table keyed this way (agents, overrides, skills) is dropped in both `deleteWorkspace` and `purgeUserData`; `accountDeletion.test.ts` counts the drops. Instructions a team wrote (a
  custom agent's, a rewritten built-in's: `briefByTeam`) sit in the resident's system prompt inside
  `<role_instructions>`, under the shared rules. Every role lookup takes a `Roster`
  (`actions.canvasRoster` / `rosterFor` on the server, `useRoster` / `useCanvasRoster` in the
  browser): the canvas GET and room `init` carry `team` (every `brief` emptied, so view links never
  read instructions) and a `team` room message updates open canvases, also when a canvas moves
  between a workspace and its owner's personal space (`actions.announceTeam`). Comments, the composer (an
  @mention there picks the card's pipeline), automation steps (the shared parser keeps the
  candidate ids, `narrowStepRoles` picks the canvas's first real one on save, and the step's canvas
  is checked again when it runs) and `get_canvas` (`customAgents`) read it. Work left for an agent
  that is deleted or off goes to Doop. Routes: `/api/agents` and `/api/agents/builtin`
  (`?workspace=`, members only). Tests: `customAgents.test.ts`, `customAgentsHttp.test.ts`.
- Editor extension (`vscode-extension/`, `server/editorConnect.ts`, `shared/editorConnect.ts`,
  `src/pages/EditorConnect.tsx`): Doop in VS Code and its forks, online only. The activity bar lists the account's
  canvases (MCP `list_canvases` with the extension's agent key), a canvas opens as a webview tab holding the live app
  in an iframe, the editor's own agent mode gets `/mcp` through `registerMcpServerDefinitionProvider`, and "Connect
  Coding Agents…" writes the `doop` entry into Claude Code (its CLI, else `~/.claude.json`), Codex (only its own
  table, every header spelling found, `vscode-extension/src/toml.ts`), Cursor, Gemini CLI and Windsurf configs.
  Sign-in: `/editor/connect` (signed in, confirm) answers a two-minute code over the editor's deep link
  (`<scheme>://doop.doop/auth`, only known editor schemes and this extension's authority), and `POST
/editor/exchange` trades it once for an agent key named after the editor, minted then, so an unfinished sign-in
  leaves no key. `/editor/whoami` checks a pasted key; `/editor/sign-out` deletes the key. The canvas view signs in
  with `POST /editor/embed-ticket` (Bearer key, one minute, single use) and `GET /editor/embed`, which only for an
  iframe (`Sec-Fetch-Dest`) sets the session cookie as `SameSite=None; Secure; Partitioned`, since a webview's iframe
  is third party and the usual Lax cookie is never sent. Every view of one key shares one session, marked by its
  `userAgent` (`agentKeys.embedSessionAgent`), which `deleteAgentKey` deletes with the key. The cookie is Secure, so a
  self-hosted server on plain http (not localhost) cannot sign the view in; the tab says so. Codes and tickets are in
  memory (one process). Built by `scripts/build-vscode-extension.mjs` (`--vsix` packs it), published on a `vscode-v*`
  tag by `.github/workflows/vscode-extension.yml`. Tests: `editorConnect.test.ts`, `editorConnectHttp.test.ts`,
  `vscodeToml.test.ts`.
- Agent API (`server/agentApi.ts`, mounted at `/api/v1` ahead of the session gate): frames as files over
  HTTP for a process holding an agent key, which is the only credential it takes (a browser session gets 401).
  `GET /frames/:id/html` answers the frame as agents edit it (`?form=rendered`: composed, as it renders),
  `PUT /frames/:id/html` replaces it from the raw body and `POST /canvases/:id/frames?name=&width=&height=&page=`
  creates one. Writes go through `runCanvasWrite` with the MCP surface's inline-data rule, one operation
  per request (`withArgsCanvases`), under the roles the MCP tools use, and a read waits for queued component changes as `get_frame` does. A frame's `updatedAt` is its version:
  the `ETag`, and `If-Match` becomes the write's `ifUpdatedAt`, checked in the same step as the write.
  An answer to a write is sent after its operation has committed. A write answers the frame, `html_changed` (the canvas stored the markup differently), `warnings` (what
  could not be done with components), `notes` (reuse advice) and the human `feedback` it claimed. Errors are
  `{ error: { code, message } }`: 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409 `conflict` (with the
  frame as it is now), 422 `refused` (inline data), 400 `invalid` (a body that is not HTML, a bad `If-Match`),
  413 `too_large`. The agent is its account plus the `Doop-Agent` header, the identity an MCP agent of that
  name has. Tested in `tests/agentApi.test.ts`.
- Doop CLI (`cli/doop.ts`, `cli/doop/`, built to `public/cli/doop.mjs` by `bun run build:cli` and served at
  `/cli/doop.mjs`; the same bundle is the npm package `@doop-design/cli`, packed into `cli/dist` by
  `bun run pack:cli` with its own version in `cli/package.json`, released as in
  [RELEASE.md](RELEASE.md#doop-cli-npm)): Doop from a shell, for coding agents and scripts. Frame HTML goes over the agent API;
  everything else is plain `tools/call` requests to `/mcp` (no session, no SDK), so it has the MCP tools'
  permissions, transactions and human feedback. One dependency-free file, with an agent key for both.
  - Browser sign-in (`shared/cliConnect.ts`, `server/cliConnect.ts`, `src/pages/CliConnect.tsx`,
    `cli/doop/login.ts`): `doop login` with no key listens on a loopback port and opens `/cli/connect` with a
    random `state`, the port, the machine's name and the hash of a secret verifier. The page, signed in, asks
    the person to confirm; `POST /api/cli/connect` answers a two-minute, single-use code as the loopback
    address to go to (`http://127.0.0.1:<port>/callback`, nothing else) or, with `--no-browser`, as the code
    itself to paste. `POST /cli/exchange` trades the code and the verifier for an agent key named `doop CLI on
<machine>`, minted then (`answerWithKey` in `server/editorConnect.ts`, shared with the editor flow); a wrong
    verifier spends the code. The flow is the editor extension's with a
    verifier in place of a deep-link allow-list. The CLI trades the code before it
    answers the browser, so the tab says it worked only when it did. With `CI` set it refuses at once, and where
    it gets no loopback port it falls back to pasting. Signing in again replaces a minted key and deletes the
    old one; `doop logout` deletes a key a
    browser sign-in minted (`POST /cli/sign-out`, where a key can only delete itself) and only forgets one the
    person brought. `BROWSER=none` keeps the CLI from opening a browser. Tests:
    `cliConnect.test.ts`, `cliConnectHttp.test.ts`, and the whole flow in `doopCli.test.ts`.
  - Sign-in: `doop login --key`, kept per server in `~/.config/doop/credentials.json` (0600), or `DOOP_API_KEY`.
    A saved key goes to the server it was saved for. A key from the environment or `--key` goes only to a
    server its holder named (`--server`, `DOOP_SERVER`, else doop.design), never to one that only a
    `.doop/config.json` or a `doop link` URL names (exit 4): a cloned repository must not collect it.
    A linked directory uses its config's server, whichever one was signed in to last, and `doop login` signs in
    to a server its holder named (never the linked one unasked) and checks the key it was given. `agent_name` is
    `--agent`, `DOOP_AGENT_NAME`, else the harness it runs under (Claude, Cursor, Gemini, Codex), else "Doop CLI".
  - `doop link <id, name or URL>` writes `.doop/config.json` (canvas, server, the directory frames are
    pulled to; meant to be committed; a `dir` or a tracked path that leaves the project is refused) and `.doop/.gitignore` for `state.json`,
    `shots/` and `expanded/`.
  - Frames are files: `pull` writes a frame's HTML to `<dir>/<slug>.html`, `push` sends a changed file and
    creates a frame from an untracked one. `.doop/state.json` holds, per file, the frame id, the sha256 of
    the HTML both sides last agreed on and the frame's version. A push carries that version, so the server
    refuses a stale file as it writes (exit 3) unless `--force`; a frame that moved on without its HTML
    changing (renamed, approved) is retried at its new version, and an element id stamped for a comment
    counts as a change, so an older file cannot strip it. A pull over a file that changed locally too is the
    same conflict. A tracked frame deleted on the canvas is reported as gone and its file kept. After a push
    the file is rewritten when the canvas stored the markup differently, and `warnings` print first.
  - Components are files too, in `<dir>/components/`: `<slug>.html` (the template), `.css` (its rules) and
    `.json` (name, description, props), from `get_component`. A push sends only the parts that changed
    through `update_component` with the pulled revision as `expected_rev`, so the server refuses a stale one
    in the same write (exit 3). A name or description change does not move the revision, so a push that
    changes the `.json` also sends the name and description it pulled (`expected_name`, `expected_description`)
    and the server refuses the write in the same way when either has moved since. New files go through
    `create_component`. Components are pulled and pushed before frames. A pull over a component whose `.html`
    is missing keeps an edit to its `.css` or `.json`: it puts the template back when the canvas has not
    changed since, and is otherwise a conflict until `--force`, whose hint says to restore the `.html` before
    pushing. A component's main
    frame is not pulled as a frame, and a component that follows a
    workspace library is listed but not pulled. `screenshot` on a component file is `get_component_preview`.
  - `doop expand` (and `pull --expand`) writes a frame as it renders (`get_frame` with `expand_components`)
    to `.doop/expanded/`, marked as generated; `push` refuses any path under `.doop/`.
  - `screenshot`, `export` and `call` write images and PDFs to disk and print the path (`.doop/shots/` for
    screenshots); `inspect` prints `problems` only, the full report under `--json`.
  - `doop wait` polls `get_comments` and then `get_feedback` (which claims the requests, so nothing may fail
    after it) every 5s and exits when a person leaves something, or with exit 6 after `--timeout` (30m unless
    set, 0 for none). New comments are those after the mark in `.doop/comments-seen.json`, the newest one a
    wait has seen on that canvas, so one left between two waits is reported by the second, and a directory
    linked to another canvas starts again. The mark has its own file so that a wait, which runs for minutes
    beside `push`, never writes `state.json` and cannot undo what a push tracked; `.doop` files are written
    through a temporary file and renamed.
  - `tokens pull` writes `get_tokens` in any of its formats; `tokens push` sends only what differs from the
    canvas (`create_tokens`, then `set_tokens`), deleting only with `--prune`. `asset upload` fills the
    one-time upload ticket for a local file.
  - `pull` and `push` refuse `--canvas` for another canvas than the linked one, and what the server said
    beside an earlier step (warnings, claimed feedback) is printed even when a later step fails.
  - `doop call <tool> key=text… key:=json… key@=file…` runs any MCP tool with `canvas_id` and `agent_name` filled in, `doop tools`
    lists them, and `doop guide` prints the CLI's own primer (`cli/doop/primer.ts`) ahead of the agent guide.
    `doop init` writes a marked block into `AGENTS.md` and, in a repository set up for Claude or with
    `--skill`, `.claude/skills/doop/SKILL.md`.
  - Ids are nanoid's ten characters, so one in 64 starts with a dash: `parseCommandLine` (`cli/doop/args.ts`)
    reads an id-shaped word that is no option's spelling as an argument, or as the value of the option before it,
    where `parseArgs` alone refused it as an unknown option. Tests: `doopCliArgs.test.ts`.
  - Output is text, or one JSON document (`ok`, `data`, `notes`, `feedback`) with `--json`. Exit codes: 1
    failed, 2 usage, 3 conflict, 4 not signed in, 5 not found, 6 wait timed out. Tested in
    `tests/doopCli.test.ts` against a real server.
- Agent identity (`shared/agentIdentity.ts`): an outside agent is its account and its `agent_name`,
  not the name alone, so two people's "Claude" on a shared canvas are two agents with their own
  presence and tasks. `mcpAgentKey` hashes the two into the opaque `agentKey` on the `Actor`, the
  presence (keyed and `clientId`'d by it) and the task (`tasks.agent_key`, migration 0061);
  `set_status`, auto tasks, `endAgentTasks` on presence expiry and the guidelines nudge match on it
  (`isAgentsTask`), as do the editor's task and face fly-tos (`taskFrameId`, `locatePresence`).
  Not the MCP session: in PostHog's `custom_agent_connected` (one per `initialize`) Codex and the
  `openai-mcp` clients start a session every few seconds and Claude Code in bursts, so a session key
  would split one agent into many; one person's two agents of one name stay one agent. Resident
  roles carry no key and are their name. Feedback on an outside agent's task waits
  `OWNER_FIRST_MS` (a minute, the presence lifetime) for that agent before any agent may take it,
  and `get_feedback` and delivered feedback say whose work it is about (`whoseWork`). Tests:
  `agentIdentity.test.ts`, `agentIdentityHttp.test.ts`, the shared-name cases in `locate.test.ts`.
- Skills (`.context/specs/skills.md`, `shared/skills.ts`, `server/skills.ts`, `server/skillRoutes.ts`,
  `src/components/Skills.tsx`): named instructions a workspace (Workspace → Agents) or a person
  (Settings → Doop Agent, for their personal canvases) writes once, at most 50 per scope, in
  `skills` (migration 0060, `scope` as in `custom_agents`, mirrored in memory). A handle
  (`brand-check`) is fixed once created. `/handle` in a request asks for one: `skillHandlesIn`
  finds a `/handle` that starts the text or follows whitespace or `(` and ends at whitespace or
  punctuation, so paths and URLs are never skills. The resident run scans its cards, comments,
  feedback, each feedback's task and what came before each comment in its thread
  and the instructions a team wrote for the running agent
  (`requestedSkillsPrompt` in `server/resident.ts`), and `skillsBlock` adds the bodies of the
  first five the canvas's scope has as a cached system block after the guidelines, on both the API
  and harness paths; a handle with no skill changes nothing. Skill text never reaches canvas
  viewers. Route: `/api/skills` (`?workspace=`, members only). Typing `/` in the composer, a
  comment, a reply, an automation's agent step, Home's prompt box or an agent's Instructions opens `useSkillMenu` (`src/components/SkillMenu.tsx`,
  `partialHandleAt`), fed by `GET /api/canvases/:id/skills` (edit role, handle and description
  only, plus `addIn`: where this viewer may add one); Home, before its canvas exists, reads
  `/api/skills` for the scope it will make the canvas in. The composer also has a Skills button that
  writes the `/`, and its menu ends with "New skill", the skills card's form via `?skill=new`. Tests: `skills.test.ts`, `skillsHttp.test.ts`, `residentSkills.test.ts`,
  `skillMenu.test.tsx`, `skillsCard.test.tsx`, `agentInstructionsSkills.test.tsx`.
- GitHub import runners (`server/index.ts` import route, `server/githubRecon.ts`, `shared/agentLaunch.ts`,
  `src/components/RepoAgentGuide.tsx`): the route answers who builds the cards (`runner`): the Doop Agent on a
  model account; the Claude Plan, whose desktop session gets the cards with `read_repo_files` / `finish_repo_card`
  harness tools (`runRepoCardsOnHarness`; it waits while the desktop is offline); or, with no Doop Agent but an MCP
  agent of their own, cards marked `payload.outside` that no resident claims and only that person's agent takes with MCP
  `take_repo_cards`, `read_repo_files`, `finish_repo_card` (a REPO IMPORT notice tells it; a delivery runs the
  inline-data rule of every agent write, and a card lands once however often it is delivered; the repo tree is kept
  five minutes per connection, `fetchTreePaths`). With neither, the import
  window asks who should build it and re-imports once an agent connects. The window opens the person's agent with
  the prompt filled in (`agentLaunch`: Claude Code `claude-cli://`, Claude Desktop `claude://`, claude.ai and
  ChatGPT `?q=`, Cursor `cursor.com/link/prompt`; Codex a terminal command) and shows the cards' progress. Connecting
  a plan and importing again hands waiting cards to the Doop Agent. Repo runs narrate presence only
  (`narrateAgent`), so a failed card never leaves a finished-looking task; a card the person queued that fails while
  the canvas is open is a toast (`CardFailureNotices`), and repo cards nobody took yet show as waiting in Recent tasks. In a browser, Settings shows a Plan that is
  on as connected, with the desktop's online state from `/api/agent-runners`. A repo is connected by its GitHub link
  (`parseRepoRef` in `shared/githubRepo.ts`: browser links, clone URLs or `owner/repo`; a `/tree/` or `/blob/` link's
  branch is the longest prefix of its path the repo has), connecting a repo the canvas already has on that branch
  gives that connection the new credential, and connecting goes straight on to the screen picker. Tests:
  `repoCards.test.ts`, `agentLaunch.test.ts`, `githubRepo.test.ts`, the connect-by-link cases in `github.test.ts`.
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
  A run's outcome is read from Claude Code's closing `result` event (`run_result` in `claude.rs`):
  `is_error` decides success (an API error still says `subtype: "success"`), the text is `result`,
  else `errors`, and `error_max_turns` is sent as `limitReached`. The resident (`server/resident.ts`)
  sets no turn limit on the person's own connection (the shell passes Claude Code no `--max-turns`;
  older shells clamp the job's `HARNESS_MAX_TURNS` to 80), only `RUN_TIME_LIMIT_MS`, the 30 minutes
  the relay also gives a run (`expiry` in `server/localAgentRuns.ts` reports it as `limitReached`);
  runs on Doop's key keep 60 / 80 turns. A run stopped at a limit is judged by its work as a capped
  API run is, and the resident puts any other failure's own
  words on the card (`crashReason` in `server/runFailure.ts`): the CLI's text, or an error the model
  call itself threw on the person's own connection, never one of ours or a server-tier one. A
  failure the relay words itself (`fromDoop`: the desktop went away, a worker is down) is shown as it
  is. A shell from before `limitReached` is read by its fallback text (`shellResult`).
  Tests: `runFailure.test.ts`, `result_event_reads_is_error_and_errors` in `claude.rs`.
- Checked work (`server/changeChecks.ts`, its header has the rules): a resident run on a card must have
  looked at what it changed before it finishes. Tests: `residentChecks.test.ts`.
- Model menus (`server/modelCatalog.ts`, `GET /api/model-account/models`): the connected
  account's picker asks the provider's catalog with the user's own key when it opens (the
  composer's `ModelPicker`) or mounts (Settings, `useAgentModels`), merging the curated entries of
  `shared/modelMenu.ts` / `shared/localAgent.ts` on top as `recommended`; a provider without a
  loader, or one that cannot be reached, gets the curated menu with `live: false`. Anthropic and
  OpenAI (`/v1/models`), Gemini (`/v1beta/models`) and ChatGPT subscriptions (the Codex backend's
  catalog, `CHATGPT_MODELS_URL`, asked with the account's token as Codex CLI
  `CHATGPT_CODEX_CLIENT_VERSION`; the route refreshes the token first) have loaders, each with a
  family filter for reasoning chat models with tools, images and a 16k output window; a picked id
  only has to be shaped like the provider's, and the run is the final check. OpenRouter, DeepSeek,
  Kimi and Kimi Code stay on their curated rosters (the run-time vision check knows only the roster's flags).
- DeepSeek and Kimi keys (`deepseek-key`, `kimi-key`) and the Kimi Code plan (`kimi-code`, a
  Kimi membership's key, sent with a `Doop/<version>` User-Agent as Kimi Code's terms require)
  run on the Chat Completions transport (`server/chatCompletionsAgent.ts`) against fixed URLs
  (`DEEPSEEK_CHAT_URL`, `KIMI_CHAT_URL`, `KIMI_CODE_CHAT_URL`, an operator's override only). Both refuse a tool-calling conversation that drops an earlier turn's
  `reasoning_content`, so the transport keeps it as a `thinking` block in the run's history and
  sends it back where the config sets `echoReasoning`. Tests: the `reasoning_content` cases in
  `chatCompletionsAgent.test.ts`, `rosterRouting.test.ts`, `providerKeyAccounts.test.ts`.
- Custom providers (`shared/customProvider.ts`, `server/customProviders.ts`,
  `server/customProviderFetch.ts`, `src/components/CustomProviderForm.tsx`): any OpenAI Chat
  Completions or Anthropic Messages endpoint, added in Settings → Doop Agent by name, API type, base
  URL, an optional key and the models it offers (each with "Sees images" and an optional max output
  tokens, which caps the turn's budget). One is a `model_accounts` row of kind `custom:<id>` (id
  minted by the server, at most 10 per person) with its description in `custom` (jsonb) and extra
  headers in `custom_headers` (sealed; migration 0051), so on/off, the default, the composer pick and
  disconnect are the ordinary account routes. `POST /api/custom-providers` adds, `PUT
/api/custom-providers/:kind` edits (a key or headers left out are kept, empty clears them);
  `/models` lists the endpoint's ids and `/test` runs one turn that must call a tool, both rationed per
  person and able to use an edited provider's stored secrets. Every request goes through
  `customProviderFetch`: https to public addresses only, DNS pinned per request, no redirects, 32 MB
  response cap; `DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS` admits private hosts and http for a self-hosted
  instance, `DOOP_CUSTOM_PROVIDERS=false` turns the feature off (existing ones read as disconnected).
  Advanced: extra headers (routing and framing headers refused), `max_tokens` vs
  `max_completion_tokens`, and echoing `reasoning_content`. Tests: `customProvider.test.ts`,
  `customProvidersHttp.test.ts`, `customProviderForm.test.tsx`.
- Reasoning effort on a user's OpenAI account (ChatGPT subscription or OpenAI key): the pick lives
  in `model_accounts.reasoning_effort` (`REASONING_EFFORTS` in `shared/modelMenu.ts`: low / medium /
  high / xhigh), set through `PATCH /api/model-account/:kind { effort }`, read by `effortFor` in
  `server/openaiAgent.ts` for every turn, with `DOOP_AGENT_OPENAI_EFFORT` as the default until a
  user picks. The status reports the resolved `effort` for the OpenAI kinds only, which is what
  shows the `Segmented` switch in Settings and the radio group in the composer's `ModelPicker`.
- Image descriptions (`.context/specs/image-descriptions.md`, `server/imageDescriptions.ts`,
  `shared/imageDescriptions.ts`): raster uploads emit `asset.stored` and get an asynchronous
  description. Billing resolves uploader → eligible canvas owner → server; Off on either
  person stops analysis, and a server-only uploader bypasses both accounts. The stable uploader
  ID is `assets.owner_id`; migration 0050 persists `describe_payer_id` and `describe_provider`
  before work so retries never change payer. Runtime errors do not trigger billing fallback.
  The in-memory queue defaults to two concurrent jobs, three attempts 30s apart, and 200
  attempts per canvas per UTC day (counter resets on restart). A 20s deadline bounds storage,
  resizing and model work. Deleted canvases are skipped. Startup recovers unfinished assets;
  migration 0050 excludes pre-feature history. Settings uses `image_description_prefs` and
  `GET`/`PUT /api/image-descriptions`. Agents read `images` on frame summaries and in resident
  kickoff; only standalone image layers are marked pasted references. Success broadcasts
  `asset:described` without changing frame HTML. Tests: `imageDescriptions.test.ts`,
  `describerModels.test.ts`, `imageDescriptionsMcp.test.ts`, `imageDescriptionsHttp.test.ts`,
  `imageDescriptionsCard.test.tsx`.
- Connections and the default (`server/agentDefaults.ts`, `server/modelAccounts.ts`): a person can
  connect every provider at once, one `model_accounts` row per user and kind (composite key and an
  `enabled` flag, migration 0046), plus the Claude Plan on their desktop (`local_agent_preferences`,
  whose `enabled` is the Plan's on/off). Settings → Doop Agent (`ConnectionTable.tsx`) is grouped
  lists: "Connected" (provider tile, name with a Default or Off badge, a short line, then the model
  dropdown with the effort as a `StepSlider`, the on/off switch and a "…" menu: Make default,
  Replace key (a modal) or Claude Code settings (a modal: which CLI, a pinned model), Disconnect),
  "Add an agent" (every provider not connected, each with Connect; the one being connected shows
  its key field or sign-in under it) and "Image model" (`ImageModelCard.tsx`, a pickable list);
  `agent_defaults`
  stores the marked provider (`PUT /api/agent-runners/default`, connected and on only).
  `resolveDefault` passes over a mark on a connection that is gone or off, then falls back to the
  Plan while on, then the account
  connected first that is on. Account routes are per kind (`/api/model-account/:kind` takes
  `PATCH` and `DELETE`; `GET /api/model-account/models?kind=`) and every one answers with
  the whole view (`accountsView`: every account on or off, the default, the menus). The meter
  counts any connection that is on and names the default; image generation uses the enabled
  account matching the image provider (ChatGPT before an OpenAI key; the "GPT Image API" models (2.6, 2.5, chatgpt-image-latest, 1.5, 1 Mini) run on an OpenAI key only, through the Image API `/v1/images/generations`, since the ChatGPT backend ignores the image model id), server keys only for
  someone who connected none (switching every account off does not count). Tests: `anthropicAccount.test.ts` (end to end), `defaultRouting.test.ts`,
  `agentRunners.test.ts`, `chatgptProviderSwitch.test.tsx`, `localClaudeConnection.test.tsx`.
- Which connection runs a task (`shared/agentRunner.ts`, `server/agentRunners.ts`):
  `GET /api/agent-runners` lists every connection that is on, with its menus, plus `default`.
  The composer's `ModelPicker` offers each one and its models; the pick is this browser's
  (`src/lib/runnerPick.ts`, `doop:agent-runner`), rides on the card as `runner` (a `RunnerPick`:
  provider, model, effort; `tasks.runner` JSON, migration 0045) and the send button's meter names
  it. `pickModel(payerId, pick)` honours it for that run when the named connection is on, a
  model the provider does not know runs on the connection's configured one, and anything else
  runs on the default. One resident run claims work that agrees on the pick (`actions.nextWork`,
  the `runner` filter on the take functions): comments and automations carry none and run on
  the default, feedback runs on what its task ran on (kept on the feedback, `feedback.runner`,
  migration 0047, so a trimmed task history cannot move it). Tests: `agentRunner.test.ts`,
  `runnerQueue.test.ts`, `modelPickerRunners.test.tsx`, the pick cases in
  `localAgentRouting.test.ts`.
- Pages over MCP (`server/mcp.ts`): `get_canvas` lists `pages` (id, name, `startFrameId`) and
  every frame's `pageId`, and narrows to one page with `page_id`; `create_canvas_page` adds an
  empty page at the end (`actions.createCanvasPage`, a server-minted id, `MAX_PAGES` enforced)
  and returns it for `create_frame`'s `pageId`; `set_canvas_pages` stays the whole-list call for
  rename, reorder and delete; `update_frame` moves a frame between pages; `update_canvas` renames
  the canvas itself (`actions.renameCanvas`, the app's own rename; a name it already has changes
  nothing). Agents' canvas names are capped at `MAX_CANVAS_NAME` as page names are at
  `MAX_PAGE_NAME`. The guide's "Frames and HTML" section says when a page beats a frame. Tests:
  the page and `update_canvas` cases in `mcp-tools.test.ts`, `residentPageTools.test.ts` (the
  resident has the same tool).
- Fitting a frame to its content (`server/frameFit.ts`, `measureContent` in
  `server/screenshot.ts`): `fit_to_content` (`FIT_AXES`: `"height"`, `"width"`, `"both"`) on
  `update_frame`, `create_frame` and `set_frame_html`, for MCP agents and the resident alike
  (`updateFrameMetaWithFit`, `fitWrittenFrame`, `readFitAxes`, the shared wording in `FIT_ON`),
  sizes the frame to its content as the server's Chromium lays it out, so agents stop guessing
  sizes between screenshots (#532). `"width"` hugs, as a Figma frame does: the root at
  `width: fit-content` for one measure, never wider than the frame, checked against document scroll overflow with the authored CSS at each proposed width (up to six attempts), in case a media query lays it out wider
  (`hugWidth`), at the frame's height with nothing released (switched off before the viewport changes, so resize handlers see the canvas's layout), held at the left in a right-to-left page; it suits component mains and cards, not screens, where a centred max-width layout
  would lose its gutters. `"both"` hugs, then fits the height at that width, and hugs again at that height until the two agree (three passes, then refused). Only the measured
  sides are written; a height fit is made at the call's new `width` and a width fit at its new `height`, and the page loads at that size. Each measure waits two animation frames (the frame's own resize,
  ResizeObserver and matchMedia handlers run first), awaits fonts and finishes animations, lets the
  root and body go of their height when it follows the viewport (judged before the first height measure at each width, by reading both at two viewport heights, so a width media query that fixes the height is seen: a height fixed by any rule, in px, rem or calc, stays, as does a `min-height`: one in px is the design's floor, one in vh
  is found by the 1px probe), then reports `flow` (the root's own box), `painted` (the lowest thing
  painted, and `right` the rightmost: positioned descendants, absolute `::before` / `::after` and text running past its
  element too, each cut on the axis a box clips (`overflow-y:clip` alone cuts only the bottom), leaving out fixed elements and invisible ones at `visibility:hidden` or `opacity:0`), `spills` (boxes in flow running out of their parent's content box) and `shell` (judged as loaded: the page fills its viewport
  and no more while a part at least half its height scrolls inside, an app shell on a div, the body or `html,body{height:100%}`,
  which keeps its height). `settleHeight` iterates a design sized in vh, plain or inside `clamp()`,
  `max()` or `min-height`, each measure feeding the next and sped up along the line through the
  last two, at most 9 measures on one page, uncapped so growth past the cap shows. A height holds
  when the content fits it with a px to spare at most (where the content grows with it, a px lower is tried and taken when it fits exactly, for a measure that rounded up); the growth there is then measured over a
  wide span below (a few px would read rounding as slope), and a design that keeps outgrowing the
  frame (a 100vh hero with more below) or grows by more than 0.6 of it (`STEEPEST_FIT`) is
  refused. Content filling the frame exactly is measured at a 1px viewport: a `min-height:100vh`
  wrapper still flows to its content there and shrinks to it (searched from there when vh parts inside still grow), a `height:100vh` one collapses to
  its overflow and keeps its height, as does one whose padding or border outlasts the tiny viewport: at that floor its content spills out of its box, which a wrapper that grows never does. The intrinsic estimate is checked against native scroll overflow with authored dimensions
  restored. If percentage children or positioned content need more height, the search brackets
  a passing height and refines it within `MAX_EXPORT_SIDE`. A fresh render at the final size
  verifies every requested axis together, including layouts set by scripts at startup. Overflow
  beyond the allowed size or after the fresh load refuses the fit. The patch is
  checked (`checkFrameMeta`) before the browser is asked; a fit is refused with the side it measures
  (`height` for a height fit, `width` for a width fit), while an
  agent streams into the frame, and when the design changed during the measurement, and a refused
  fit applies none of the call. After `create_frame` / `set_frame_html` the write is committed
  before the browser wait (`checkpoint`) and a failed fit leaves it standing with a note. A
  broadcast that does not change a frame's design (rename, resize, restack, sign-off) sends viewers
  what they have (`frameForViewers`): the revealed part mid-playback, the healed stream mid-stream.
  Server renders (`loadFrameInto`) add `<!doctype html>` to a design without one, since the editor
  morphs every design into a standards-mode document (`FRAME_BOOTSTRAP`), and put the asset
  `<base>` in the document's `<head>`, never ahead of its doctype or inside a `<header>`; every
  render sizes its viewport through `frameViewport` / `designPx`. Tests: `frameFit.test.ts`, the
  fit cases in `residentPageTools.test.ts` (`tests/measureGate.ts` holds a measure so a test can
  change the frame mid-fit without a timer).
- Feature usage events: a feature an agent can reach reports from the server through
  `captureFeature` (`server/featureEvents.ts`) at the REST route, MCP tool and resident tool, on the
  signed-in user, the agent's connecting user or the resident run's requester, with `via` (`ui`,
  `mcp`, `resident`, `automation`): `tokens_changed`, `token_themes_set`, `page_background_changed`,
  `prototype_start_set`, `frame_version_restored`. Browser-only features capture
  with posthog-js: every export and Copy as PNG through `src/lib/exportEvents.ts` (`frames_exported`
  with `source` and `target`, `png_copied`), `prototype_played`, `prototype_interactions_saved`,
  `text_formatted`, `svg_imported`, `pdf_imported`.
- Which client: web events carry posthog-js's `$os`; the desktop shell registers `desktop_app`,
  `desktop_app_platform` (`macos` / `windows` / `linux`) and `desktop_app_version` on every event
  (`src/lib/posthog.ts`); the iOS app sends its own through posthog-ios (`ios/Doop/Analytics.swift`,
  `$lib = posthog-ios`, `ios_app: true`, named `$screen`s), with the token from the public
  `GET /api/analytics-config` (`analyticsConfig` in `server/analytics.ts`: `VITE_POSTHOG_KEY`, else
  `POSTHOG_KEY`, else null and the app sends nothing) and through that server's `/relay`.
  `$os = iOS` without `$lib = posthog-ios` is mobile Safari. Tests: `analyticsConfig.test.ts`.
- `ws` 8.18.0 - WebSocket server for realtime multiplayer (cursors, presence, frame edits,
  activity feed) over one room per canvas.
- Storybook import (`.context/specs/storybook-import.md`, an extension: `server/storybook/`,
  `src/integrations/storybook/`, shared `shared/storybook*.ts`, CLI `cli/doop-storybook.ts` built to
  `public/cli/doop-storybook.mjs` by `bun run build:storybook-cli`): a Storybook's stories into Doop
  components. `storybookPage` runs in the story's page (the server's renderer for a public
  Storybook; the developer's Playwright, Puppeteer or Chrome through the CLI for localhost or a VPN,
  which sends captures to MCP `import_storybook` with an agent key): props from the preview's
  story store (enum and boolean controls as enum props, shown string args as text props), each
  value re-rendered over the addons channel, CSS from the CSSOM, decorators stepped past, dark
  through a theme global or `prefers-color-scheme`. `buildKit` turns the class differences between
  renders into `[data-<prop>]` rules, `.dark` into `[data-doop-theme="dark"]`, theme colours into
  tokens; the importer writes fonts (`addCanvasFont`), tokens and components (`runComponentTool`,
  so every note an agent gets applies), checks each main against its story's pixels
  (`fidelity.ts`) and keeps the source in `storybook_sources` for sync (a content
  hash per component; tokens it made update, others are left alone). REST under
  `/api/canvases/:id/storybook`, MCP `list_storybook_components` / `import_storybook` /
  `sync_storybook`, a job per canvas shown as the "Storybook Import" task. Tests:
  `storybookKit.test.ts`, `storybookCaptureBrowser.test.ts` (fixture `tests/fixtures/iframe.html`),
  `storybookImport.test.ts`, `storybookImportHttp.test.ts`, `storybookCli.test.ts`, and the opt-in
  `storybookLive.test.ts` (`STORYBOOK_LIVE_URL`).
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
  removes). `actions.createFrame` / `updateFrame` / every append chunk run it on every write
  (`withCanvasFaces` in `server/canvasFaces.ts`; mid-stream a fragment from its first chunk, a
  document once a complete `<head>` or `<body>` tag has arrived (`streamTopSettled`), so the
  first section's screenshot already has its fonts and tokens),
  and `FrameView`'s save path runs it too, so a family picked from the Design panel's "Custom
  fonts" group renders at once. Every renderer that reads frame HTML (screenshots, PDF
  export, iOS) gets the font that way. Agents see the library as `fonts` plus a note in
  `get_canvas` and as a system block in the resident agent (`libraryBrief`): name the family,
  never load it from Google Fonts. Tests: `fonts.test.ts` (a real WOFF2 in `tests/fixtures/fonts`), `fontLibrary.test.ts`,
  `fontLibraryRace.test.ts`, `fontFrameWrites.test.ts` (faces on create, stream end and idle; an idle close sends viewers the
  healed document, so a cut-off script never runs).
- No files inside frames (`server/inlineData.ts`, `LEAN_FRAMES` in `server/guide.ts`): an agent
  write that adds a base64 `data:` URI of any kind is refused and nothing is written, with what to
  do per kind (font, picture, SVG, media). So is one that adds a block of 4,096 or more base64
  characters that is not a data: URI (`EMBEDDED_MIN_LENGTH`: a packed script bundle, a compressed
  data file in a string literal; one canvas held 6 MB of it per frame, 13 GB across its kept
  versions). Checked on what the call submits: MCP `create_frame`,
  `set_frame_html`, `append_frame_html` chunks, `edit_frame_html`'s `new_str`, every component
  tool's strings, and the resident's create / set / edit / rewrite chunks. A URI the frame already
  holds may be carried over (a PDF import embeds its fonts), so such a frame stays editable.
  Human saves, imports and ingest are not checked. `LEAN_FRAMES` (MCP guide and resident prompt)
  covers the rest: big traced SVGs as uploaded `<img>`, libraries from a CDN, sample data, no icon
  sprite sheets, a poster instead of video. Fonts go in with `upload_font` (MCP: `source_url`,
  `local_file` ticket or `data`; resident: `source_url`; `server/canvasFontUpload.ts`): the file
  joins the library the canvas designs with (its workspace's for members, the owner's own on a
  personal canvas, refused for anyone else) through `addFont`, and the agent names the family.
  A font ticket's URL ends in `/` so curl appends the file name (`PUT /u/:token/:name`, 10 MB cap).
  Tests: `inlineData.test.ts`.
- Design tokens (`shared/designTokens.ts`, spec `.context/specs/design-tokens.md`): a canvas's
  typed design values (Paper's eleven types: colour, opacity, radius, spacing, container,
  breakpoint, font family / weight / size, line height, letter spacing), each a CSS custom
  property frames use as `var(--name)`, with a value per theme (`canvas.tokenThemes`; a frame
  switches with `data-doop-theme="dark"` on its `<html>`). `withTokenBlock` makes the
  `<style data-doop-tokens>` block of the values a document names; it is composed in where a frame
  is rendered, not stored in it (Lean frame storage, below), so a value change writes no frame. A
  rename (`var(--old)` in frames' source) or a theme rename still rewrites the frames naming it, as
  an annotation (sign-off stands, no version). It reaches the canvas's own component definitions
  first (`renameInComponents` in `server/tokenRenames.ts`): every active one whose
  template, stylesheet or head names the old name gets a revision with the new one (a linked
  library definition is left to its library), and instances marked with the revision it moved
  past are marked with the new one as their frames are rewritten, so the renamed markup is never
  filed as an override. Stored in `design_tokens` + `canvases.token_themes` (migration 0050); REST under
  `/api/canvases/:id/tokens`, `/token-themes` and `/styleguide.md` (tokens + guidelines as one
  markdown); MCP `get_tokens` (json / css / tailwind / markdown), `create_tokens`, `set_tokens`,
  `set_token_themes`, mirrored on the resident agent; the Layers panel's Tokens tab
  (`TokensPanel.tsx`) and token menus on the Design panel's colour, radius and font-size fields.
  Tests: `designTokens.test.ts`, `designTokenWrites.test.ts`, `designTokensHttp.test.ts`.
- Compact frame storage (`server/frameRest.ts`, spec `.context/specs/components.md`, Model): in memory
  and on the wire a frame's HTML holds every component instance written out, as before; at rest
  (`frames.html`, `frame_versions.html`) an instance is a reference,
  `<doop-use component="<id>" id="…" …>` with its props, overrides and slot content. `restingHtml` makes
  the references where `server/db/persist.ts` writes a frame row or a version (a canvas or page
  copy is stored written out and goes compact frame by frame; `persist.restFramesThrough`, wired in `server/index.ts`, hands it the canvas's components), and
  only for an instance whose reference, expanded there and then, gives exactly the markup the write
  pipeline would hold for it; an instance of an unknown, deleted, hollow or not-yet-stored definition
  stays written out. `wakingHtml` writes references out where the store reads frame HTML
  (`store.wakeHtml`: page loads, `renderableFrame`, the version preview and restore), one frame per
  operation and per turn of the event loop, and brings instances stored written out up to their
  components' current revision; a reference it cannot render is kept as a visible placeholder
  (`data-doop-lost-use`) that the next save stores as the reference again, never dropped. So a change to
  a component's markup writes no frame: frames in memory are rendered again (`store.rerenderFrame`:
  `html` and `rendered` move, `updatedAt` does not; the room gets `frame:updated` with `rerender`), and
  the rest are rendered from the component when their page is read. Both forms are read under either
  setting of `DOOP_COMPACT_FRAME_STORAGE` (false stores instances written out again); existing frames
  go compact on their next write. Rolling the code back past
  this needs the compact rows written out first. Tests: `frameRest.test.ts`,
  `compactFramesHttp.test.ts`, `frameRerenderStore.test.ts`, `frameRestBench.test.ts` (what a heavy
  page costs to read and store).
- Lean frame storage (`shared/frameCompose.ts`, `server/frameCompose.ts`, `src/lib/frameCompose.ts`): a
  frame's stored HTML is its source. What the canvas supplies to every frame is not in it: the
  stylesheet of each component it uses (`<style data-doop-component-css>`), the head tags those
  brought (`data-doop-component-head`) and the token block. `composeFrameHtml(source, { tokens,
themes, components })` puts them in (component blocks at the end of the head, token block first,
  as writes always placed them) and `stripSharedBlocks` / `sourceOf` take them out, both string
  level, idempotent, and the same for a frame stored before this with stale blocks in it, so
  nothing is backfilled: such a frame goes lean on its own next write. Font faces, the hosted-font
  link, `data-doop-detached-css` and a hollow component's stylesheet stay in the frame. Writes
  prepare the composed document as before (the font scan reads it) and store `storedHtml` of it.
  A token value change (`restyleTokenFrames`) and a revision of a component's rules alone
  (`propagateIntoFrame`; an instance's `data-doop-rev` is its component's `renderRev`, which such
  a revision leaves alone, see Components) write a frame only when its source changes. Composed on the way out: the renderer (`renderDocument` in
  `server/screenshot.ts`, the one place every screenshot, `/i/` image, thumbnail, inspection and PDF
  export passes; a print shell or preview sheet is marked
  `wholeDocument`), MCP `get_frame` with `expand_components`, the version preview route (with the
  canvas's styles as they are now) and a Memory reference at pin time. Agents' compact form is the
  source, token block gone; `edit_frame_html` (`editFrameHtml` in `server/componentActions.ts`, MCP
  and resident) matches its text in the compact form, the stored source or the composed document,
  stores the result as source, and refuses an edit that only touched what the canvas supplies, or
  one whose replacement opens or closes more `<doop-use>` / `<template>` tags than its find text,
  or closes one ahead of its opening further than the find text does, so the tags around it would
  pair up wrongly (`tagBalance` in `server/componentEngine.ts`, `unbalancedEdit`; it reads the
  command alone, so `runCanvasWrite` refuses it before it runs;
  `tests/editFrameHtmlBalance.test.ts`).
  `asset_refs` are projected from the composed document (`persist.viewAssetsThrough`), so an asset
  a component's stylesheet names counts, as of the frame's own last write. The browser composes too: its join says `composesFrames` and its REST
  requests carry `x-doop-composes-frames`, so it is sent sources; the store keeps sources
  (`asSource`), `FrameView`, the prototype player and the drag preview post
  `useComposedFrame` / `composeFrame` output, re-posted when the tokens or a used component's
  rules change (no `frame:updated` involved), and what the runtime serializes back is stripped
  before the store, undo history or `api.updateFrame` see it. Every other client
  (the native apps, a tab on an older bundle, a script) is sent composed frames in `init`,
  `page:frames`, `frame:created` / `frame:updated` and REST answers (`withComposedFrames`), and a
  `frame:updated` for each frame a `tokens` or `component` message restyled
  (`server/legacyFrames.ts`: each connection keeps a key of `composeFrame(...).shared` per frame
  it was sent; a change composes only the frames a string check says it can reach, the changed
  component's instance marker or the changed token names with their dependents, once per frame
  however many such connections there are). A render is stamped with what it was supplied
  (`server/styleVersion.ts`, `stampRender`: the frame's `updatedAt`, plus the versions of the
  tokens its document names and the components it uses, taken when the render reads its HTML),
  so the `/i/` cache and thumbnails retire a render when one of those changes, not on any other
  change to the canvas, and checking a stamp reads no frame HTML.
  `DOOP_LEAN_FRAME_STORAGE=false` is the temporary switch back to storing composed documents and
  rewriting frames on token changes; reads compose either way. Tests: `frameCompose.test.ts`,
  `leanFrameStorage.test.ts`, `leanFramesHttp.test.ts` (both settings, legacy and composing
  connections, renders), `legacyFrames.test.ts`, `sharedStylesBrowser.test.ts`.
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
- Feedback from people (`shared/productFeedback.ts`, `server/productFeedback.ts`, `src/lib/feedback.ts`,
  `src/components/FeedbackModal.tsx`): a signed-in person writes a short note (up to 2,000 characters)
  and `POST /api/product-feedback` emails it to `FEEDBACK_EMAIL` through `sendMail`, with the sender as
  Reply-To and the page they were on; nothing is stored, five notes an hour per account, PostHog gets
  `product_feedback_sent` (length and page, never the text). Unset `FEEDBACK_EMAIL`, `/api/me` carries
  `feedback: false` and no button shows. Entry points all call `openFeedback()`, shown by the one
  `FeedbackHost` in `App`: the rail's Feedback row, the account menu, the canvas Help menu and the
  `feedback` action (main menu, ⌘K). Agents have their own channel (Agent feedback, above). Tests:
  `productFeedback.test.ts`.
- Plans and the way to Pro (`shared/billing.ts`, `server/entitlements.ts`, `src/lib/upgrade.ts`,
  `src/lib/planFeatures.ts`, `src/components/PlanCards.tsx`): the paid plan is sold as Pro (its id
  stays `team`: Stripe metadata, the workspaces table and `/api/me` carry it); plan copy lives in the
  `plans` catalog. Pro still lives in a workspace,
  and its perks follow the person (a member of a live paid workspace, `planFor`) or the canvas (in
  one): uploads to 100 MB instead of 5 (`uploadCap`, applied to browser uploads, the `/u/` ticket and
  MCP `upload_asset`; imports and generated images keep `MAX_ASSET_BYTES`), and font libraries past
  `FREE_FONT_FAMILIES` (2; a new family over it is a 402 `{ upgrade: 'fonts' }`, more faces of a family
  already there always pass). Billing off, nothing is limited. `/api/me` carries `billing`; with it on
  and the account on Free, the rail shows "Upgrade to Pro", the account menu an Upgrade item (Pro
  gets Priority support, `PRIORITY_SUPPORT`), Settings → Plan the current plan and the full
  comparison, the canvas Help menu and ⌘K an `upgrade` action, and `?upgrade` on any URL opens it.
  All of them call `openUpgrade({ source })` (`upgrade_opened` in PostHog), which the one
  `UpgradeHost` in `App` shows as `UpgradeModal` with no workspace: it pays for the person's unpaid
  workspace, or names a new one that checkout creates, or says which workspace they are on Pro
  through. Its name is a placeholder (`plans.defaultWorkspaceName`): when checkout comes back paid the
  Workspace page asks for the real one once (`NameWorkspaceModal`, a per-browser note from
  `noteNameAfterCheckout`). Seats are a minimum (`workspaces.seats_bought`, migration 0059): the owner
  picks them at checkout (`SeatStepper`) or on the billing pane (`PUT /api/workspaces/:id/billing/seats`),
  and Stripe bills `billedSeats` = the larger of seats bought and members, so invites fill bought seats
  first. "Team API keys for CLI and CI" is listed as Soon: not built. Tests: `planLimits.test.ts`,
  `upgradeModal.test.tsx`.
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
  scripts and `srcset` are dropped, as are comments and attribute names only HTML reads (`@click`, `:class`), which no XML parser takes back (#508), a link's `media` kept; a nested document (iframe, object, embed) sends
  the frame to the server, since it would be a hole in the picture),
  and the SVG is drawn onto a canvas at 2x from a data: URL (a blob: URL taints the canvas in
  Chromium) and encoded. A resource the browser cannot fetch (an image host without CORS)
  rejects the whole render and the export falls back to `/i/<id>.<ext>` as before, so what the
  person sees on the canvas is never the export's blocker. An element inside a frame exports
  too (the element menu's Export… dialog and Copy as PNG, `downloadElementExport` /
  `copyElementPng`): the frame is rendered whole and cut to the element's live box
  (`doop:inspect` rect, `clipToFrame`, the raster's `clip` option), so every style it inherits
  and whatever paints behind it stay in the picture; a server render is cropped here the same
  way (`cropRaster`), unless a full screenshot would reduce a small layer’s density, in which case Chromium captures
  the layer by selector. A frame off screen says so. The element panel's Design tab ends with the same
  Export section (`LayerExportSection.tsx`: the shared scale and format, "Export <layer>", Copy as
  PNG), as Figma ends a layer's properties. Agents export a layer with `export_layer` (MCP and the
  resident, `server/layerExport.ts`), named by `element_id` (its `data-doop-id`) or a CSS
  `selector`; it returns `/i/<frameId>.<ext>?scale=&element=` (or `&selector=`), which renders the
  frame whole and screenshots the first match's box clipped to the frame (`layer` in
  `renderFrame`; a missing, invalid or empty match is a 404). Tests: `layerExport.test.ts`, `layerExportHttp.test.ts`,
  `layerExportSection.test.tsx`. Tests: `frameRaster.test.ts`,
  `frameRasterBrowser.test.ts` (pixels in Chromium, the live runtime included),
  `frameExport.test.ts`. Scale and format (`shared/exportScale.ts`, `src/lib/exportSettings.ts`,
  `ExportOptions.tsx`): the Inspector's Export group and the Export… dialog (frames, and elements
  from their menu) pick 0.5x / 1x / 2x / 3x / 4x or a typed multiplier (0.1-4, two decimals) and
  PNG / JPG / SVG (the frame Inspector adds PDF, the server's vector print of that frame; a layer
  reads a PDF pick as PNG, `elementFormat`), remembered per browser under `doop:export-settings` (2x PNG by default) and
  named `Name@2x.png` as Figma does. Up to 2x a scale is honoured as before; above it,
  `fitExportScale` brings a huge frame down to 16,384 px a side and 64 MP, the same limit
  for the browser render, `/i/<id>.png?scale=` (any parsed scale, 1x when unreadable) and MCP
  `export_frame`'s `scale`. Full-frame server exports then reduce density only when the
  screenshot would otherwise lose rows at Chromium’s 50 MP capture limit. The download names
  the density actually used, and the toast reports a reduction. SVG is `frameSvg`: the inlined document
  `inlineDocument` already builds, cropped by `viewBox` for an element, on white, settled for
  a file opened as a page, where the viewer's window would be the viewport (`standalone`,
  `FrameViewport`): viewport units become the frame's px, `@media` rules and `<style media>` are
  kept or dropped by a hidden iframe of the frame's size, imported sheets included, and inline
  handlers and `javascript:` URLs are stripped; HTML in a
  `foreignObject`, so it opens in browsers but is not editable vector art, and it has no server
  fallback. Tests: `exportScale.test.ts`, the scale and SVG cases in `frameExport.test.ts`,
  `frameRasterBrowser.test.ts` (the SVG opened as a page in a wide window), `exportOptions.test.tsx`
  and `mcpPdfExport.test.ts`.
- Server-side renderer (`server/renderBrowser.ts`, used by `server/screenshot.ts`): every headless
  Chromium page (frame images, MCP screenshots, the resident's checks, PDF
  exports, website imports) goes through one gate of `RENDER_CONCURRENCY` pages (default 4;
  background thumbnails get at most 2, a waiting agent goes before a waiting thumbnail), a bounded
  queue that refuses with `RendererBusyError` (HTTP 503 + Retry-After) and a lease that closes a
  page held past 120s. A browser that cannot open a page within 15s is killed with its process
  group and the open retried once on a fresh launch; a render that fails like a browser failure
  runs a health probe outside the gate and is retried once if the probe kills the browser; a
  browser is recycled after 500 pages or an hour. DevTools commands time out at 60s, not 180s.
  Screenshots are capped at 50M device px (`server/renderLimits.ts`; MCP says when it cropped).
  Every render waits for its fonts before capturing (`settleFonts` in `server/renderFonts.ts`,
  for `/i/`, MCP screenshots, inspection and PDF export): `load` does not cover a face from a
  linked stylesheet (a frame's Google Fonts link), which layout requests only after it, so the
  page is laid out to start those loads and `document.fonts.ready` is awaited, at most 5s, before
  the capture proceeds with whatever loaded. Tests: `screenshotFonts.test.ts`.
  `GET /healthz/renderer` reports the counters (`kills`, `lastOpenedAt`, `failedOpensInARow`,
  queue depth) for an uptime check. Context: the 2026-11-05 wedge, where one browser stopped
  making pages for two hours. Tests: `renderBrowser.test.ts`.
  `REMOTE_BROWSER_URL` (+ `REMOTE_BROWSER_TOKEN`, sent as a Bearer header) swaps the local launch
  for `puppeteer.connect` to a remote Chrome over CDP: Cloudflare Browser Run
  (`wss://api.cloudflare.com/client/v4/accounts/<id>/browser-run/devtools/browser`), browserless
  or a renderer service; everything past the connect is unchanged, so switching provider is an env
  change. A remote browser is closed 30s after its last page (`idleCloseMs`; providers bill open
  sessions), and one whose close stalls is disconnected, having no process to kill. Assets load
  from `BETTER_AUTH_URL`, which the remote browser must reach. `REMOTE_BROWSER_ISOLATED` declares the
  browser cannot reach our private network (a hosted provider): it then fetches public URLs itself
  instead of through `guardPublicPageRequests`' DNS-pinned proxy; never set it for a self-hosted
  renderer.
- `pdf-lib` 1.17.1 - joins the vector PDF export (`server/pdfExport.ts`): headless Chrome prints
  each frame onto a page of its own size (inside an iframe of the frame's size, as the canvas shows
  it, so content taller than the frame is clipped rather than paginated: bare, Chrome moved a block
  straddling the edge whole onto a dropped second sheet), pages in the order the frames are listed (a whole page
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
- Write boundary (`server/journal.ts`): every operation is one transaction over the in-memory
  state. `runOperation` opens it (an MCP tool call, detached from its HTTP request; a resident tool
  call; one frame of the propagation queue; an idle stream's settling), and the HTTP middleware
  opens one per request, committed as the response starts and undone by `undoRequest` when the
  handler threw. A write changes memory at once and records its undo (`recordUndo`); everything that
  leaves the process waits for the commit in order (`afterCommit`: `persist.*` rows, room
  broadcasts, activity, frame versions, canvas events, thumbnail purges, `propagation.enqueue` /
  `resumeFrame`, kicks to the resident agents), and `postCommit` runs follow-up work as a
  transaction of its own. A throw, a `WorkBudgetError` above all, undoes in reverse and drops the
  queue. Inside an open transaction `transaction` / `atomic` is a savepoint; the frame, token and
  component actions are `atomic`, so one called outside any operation (a job, a timer) is still
  all-or-nothing. `checkpoint()` is a sub-commit, for partial progress that is meant to stay
  (a pulled component of an import, each canvas of
  `update_library_everywhere`) and before an await that depends on committed work (the element-id
  stamp's durable write). No isolation: an undo restores only what is still its own write (a
  frame's `updatedAt`, a definition's identity). Presence touches are never queued.
  `store.duplicateCanvas` / `duplicatePage` are durable first and not undone. Every store write
  calls `requireBoundary`: outside a transaction and not marked with `outsideOperation(reason, …)`
  it does what `DOOP_WRITE_BOUNDARY` says (`warn` in development, `throw` in the integration
  harness, `off` in production). Tests: `journal.test.ts`, `storeJournal.test.ts`, the
  fault-injection sweep `workBudgetCommit.test.ts` (memory, a modelled database and a viewer's
  replayed copy, for every write operation) and `writeBoundaryHttp.test.ts` (the real server,
  rebooted on its database).
- Canvas writes (`server/canvasWrites.ts`): a frame's
  HTML and metadata are written through one entry, `runCanvasWrite(canvasId, command)`, a typed
  command carrying intent (`create-frame`, `write-frame`, `edit-frame-html` with its find and
  replace, `frame-meta`, `restack-frames`, `set-approval`, `agent-approval`, `delete-frame`,
  `restore-version`, `stamp-element-id`, and for streams `append-frame-html`,
  `settle-stream`, `close-stream`, and for tokens `create-tokens`, `set-tokens` (a rename rewrites
  the frames naming the token; a value change writes no frame under lean storage) and
  `set-token-themes` (a theme rename rewrites the frames naming it); each answers the tokens as
  its write left them, and a refused theme list rejects with `TokenThemesError`) and answering a typed result, read off its handler. An agent's
  command carries its surface (`inline: 'mcp' | 'resident'`) and the host checks the HTML it adds
  for inline data against the frame as the host holds it, by that surface's rule (`heldForms` for
  MCP, read lazily; stored HTML for the resident; a chunk joined to its stream's tail). Contract for every host: always a promise, a failure only its rejection, awaited
  inside an operation that awaits (REST through `writeRoute` in `server/index.ts`, which hands a
  rejection to `undoRequest`; MCP and resident tool calls), so a
  rejection undoes the operation. The entry refuses a frame on another canvas than `canvasId`
  (`CanvasMismatchError`) and enforces a command's `ifUpdatedAt` as it writes
  (`FrameVersionConflict`, answered over REST as the 409 `requireFrame` gives). Its only host is
  local: the actions above, which still write synchronously when called, so writes, undo and
  `afterCommit` are as before. Routed: the REST frame routes, MCP and resident frame tools,
  version restore, `/element-id`, stream chunks (MCP, REST, the welcome demo)
  and idle settling. `wireCanvasWrites()`, called once at boot by `server/index.ts`, installs the
  settler the playback tick in `actions.ts` calls (`settleIdleStreams`); so
  `actions.ts` imports nothing from `canvasWrites.ts`, and unwired, the tick says so instead of settling. A stream is settled only while it is
  still the one found idle (`lastActivity`); one whose settling fails for anything but its work
  budget is tried 3 times (`SETTLE_ATTEMPTS`, 1 s then 5 s apart), its error logged once, then
  closed unsettled, as a budget refusal is; a pass never rejects. Tokens from REST, MCP and the resident go through it. Component definitions
  go through it too (`create-component` from markup or an element, `create-components`, each
  entry its own unit, `update-component`, `delete-component`, `restore-component`,
  `restore-component-version`), from REST, MCP and the resident (`server/componentTools.ts`); each
  can answer a `view` (catalog entry and touched frames, read in the write's own step) when it
  asks (`view: true`: the agent tools; REST never asks, and pays nothing for it), and reuse notes
  are read where they always were. Instances go through it too (`insert-instance`, `change-instances`,
  from `insert_instance`, `update_instances` and REST `/api/frames/:id/instances`).
  Imports and ingest go
  through it with `create-frame` / `write-frame` (webpage and website import over REST, MCP and the
  resident; Meta; `/ingest`; the GitHub sketches).
  `runImportWrite` is a savepoint of the request or tool call it runs in, else an operation of
  its own. `landImportFrame` (a website's pages, Meta) makes each frame its own unit and
  answers a refused one as that frame's failure, so pages already landed stay; only a spent work
  budget inside a request or tool call rejects. The REST import routes have no catch of their
  own: any failure goes to `importRefusal`, which undoes the request and answers the JSON 400
  they always did (422 for a work budget). Where one function both fetches and writes (MCP
  `import_webpage`, `/ingest`), a write's rejection is marked (`isImportWriteFailure`) so the import's own catch
  passes it on; the GitHub review round fetches inside its catch and writes outside it. Comment anchoring stamps through
  `stamp-element-id` (a new comment, a moved one; both routes through `writeRoute`, and a
  charged task is given back when the comment is not posted, `server/chargedWork.ts`). The boot
  backfill uses `stamp-element-ids` (`actions.stampElementIds`: every stamp of a frame in one
  annotation write, nothing for a frame mid-stream), one operation per frame, then stores the
  row before the comments name the ids. `actions.ts` reaches the entry by a dynamic import, so
  it still imports nothing from `canvasWrites.ts` when it loads. The seed canvas at first boot
  stays a direct `store` write.
  The workspace library goes through it too: `import-component` (from a workspace library,
  linked, or a copy from any canvas the caller checked it may read), `sync-component` and
  `sync-library-updates` (one, or every waiting pull all or none; the caller's read check rides
  along as `readable`, `readableSources`), `pull-library` (one per canvas from
  `updateLibraryConsumers`, now in `server/libraryUpdates.ts`, which commits each with
  `checkpoint()` before the next, as before the entry; once a pull was committed, a refusal or a
  spent budget anywhere in a canvas's step (its load, its pull, the wait for its frames) stops the
  walk and is reported in `skipped`, the canvases not reached that still use the library as
  `not_reached`; anything else is logged and fails the call) and `carry-library-tokens` (the
  tokens of components a frame write took up, sent once that write lands through
  `carryAdoptedTokensWith`, which `wireCanvasWrites()` installs; unwired, they are carried
  directly and that is logged once; the adoption itself is part of the frame write), from REST
  (`/components/import`, `/components/:id/sync`, `/library/update-consumers`), MCP and the
  resident; `view: true` builds the catalog entry and frames in the write's step, never failing
  it. Copying from a canvas that is not a library still sub-commits per component it updates
  (`checkpoint()`). Publishing writes the library's publication, not
  a canvas, and is not routed.
  The background queue's frames go through it too (`propagate-frame`, `detach-frame`):
  `server/propagation.ts` sends each frame's turn through the routes `canvasWrites.ts` sets
  as it loads (`routeFrameTask`; unrouted, as in a test of the actions alone, the task's own
  handler does it). Each turn is its own operation, and each canvas has at most one turn in
  flight while the others take theirs. A turn unanswered after 30 s (`TURN_TIMEOUT_MS`) is
  said as failed and its canvas goes on. A canvas deleted mid-turn, or a job that ended,
  keeps nothing of the answer and reports nothing. A failing turn is undone, said and
  skipped, as before, and a tick never rejects. Detaching every instance is `detach-instances`
  (delete_component's `detach_instances`, REST `/detach-instances`), answering the ids it
  queued, and the frames only when asked (`frames: true`, the agent tools). Every server write
  to a canvas's frames, components and tokens now goes through the entry. Tests:
  `canvasWrites.test.ts`, `importWrites.test.ts`, `canvasWritesLibrary.test.ts`,
  `writeBoundaryHttp.test.ts`.
- `pg` 8.22.0 - Postgres driver for the real-database path.
- Frame HTML in memory (`server/store.ts`, `server/frameHtml.ts`): the store keeps every canvas
  and frame, but frame HTML (most of the data) loads per page. Boot reads `frames` without `html`;
  `store.loadPages(canvasId, pageIds, frameIds?)` reads the HTML of the frames on those pages (and of
  `frameIds` wherever they are) by id, 200 ids a query, concurrent loads
  sharing each frame's read; `store.load(canvasId)` is every page, for work on the whole canvas;
  `store.loadForFrames` is a frame write's: its page plus every component main (a write that carries a main
  asks whether it lives in another frame). What a read takes into memory is the frame rendered: stored
  component references are written out, each frame in its own operation and turn of the event loop
  (`store.wakeHtml`, Compact frame storage); a frame that cannot be rendered within its budget fails the load. `evictIdle` drops a page after `CANVAS_IDLE_MS` (10 min) unused,
  never while a load is on its canvas, a `store.hold` keeps it (a hold names a scope: `'all'` for an agent run,
  a job or a whole-canvas route, else the pages and frames a write or a drawing reads, `framesScope` /
  `pageScope`; releasing it counts only those pages as used), an MCP agent's presence or a stream is on the
  canvas (`inUse` true: every page), a browser in the room shows that page (`inUse` names the pages: the
  join's page until the browser says, then the ones its `pages:shown` lists; a page it only read with
  `page:load` is not one), or a frame on it is unsaved
  (`persist.frameWritePending`: dirty from a save until a write at that state succeeds, so a debounce, a write
  in flight and a failed write all count; the sweep retries a failed one); a frame loaded some other way counts
  its page as used from the sweep that sees it. `isLoaded` means every frame's HTML is in memory. Entry points load and hold for their length, and the rest stays synchronous: the REST
  middleware (behind the session gate, held until the response closes) loads a frame's routes with
  `loadForFrames` (deleting a frame and the instance routes, whole), a comment's with its frame's, a canvas's
  whole except the ones that read no frame HTML (`HTML_FREE_CANVAS_ROUTES`: guides, page colour and flow start, thumbnail, members, agents, fonts, canvas comments, page copies,
  which read their own page) and `POST /frames` (the page drawn on) and `PUT /stack` (the frames named); the
  room `join` and `page:load` (the page); every MCP tool naming `canvas_id`, `frame_id` or `frame_ids`
  (`server/toolLoads.ts` wraps `registerTool`; the whole canvas), resident sweeps and automation pulls, ingest,
  the local and Gemini agent endpoints (whole). `/i/` renders read the one frame's HTML
  (`store.renderableFrame`) instead of loading its page. Reading an unloaded frame's `html` throws
  `FrameHtmlNotLoadedError` and starts loading that frame's page, so a missed entry point fails loudly rather
  than seeing an empty design; assigning it always works. `asset_refs` is kept per write only; there is no full
  rebuild (it read all frame HTML on every boot), and a ref a failed write left behind is put right by the
  frame's next save. Context: by 2026-11-09 frame HTML was 6.4 GB on disk and ~11.7 GB of V8 heap (60% of
  frames hold a non-Latin-1 character, which makes V8 store the whole string at two bytes a character), against
  a 12 GB heap cap; on 2026-11-16 a canvas of 804 frames on 31 pages (163 MB of HTML, its heaviest page 33
  frames and 19 MB) could not open, since its init carried every page. Tests: `lazyFrameHtml.test.ts`,
  `lazyFrameHtmlHttp.test.ts` (a restart, then REST, the room, MCP and an idle drop), `pageLoadingHttp.test.ts`.
- Pages over the room (`server/index.ts`, `src/lib/ws.ts`, `src/lib/pages.ts`): a browser's `join` says
  `pagesOnDemand` and names the page it opens on (`pageId`: the page it shows on a rejoin or the URL names;
  `frameId`: a frame the URL links), which the server resolves with the browser's own rule (`openingPageId`,
  now in `shared/pages.ts`). `init` carries every frame's metadata (`WireCanvas`, `WireFrame`: a frame
  without `html`) and the HTML of that page alone, listed in `loadedPageIds`. Opening another page sends
  `page:load`; the server reads it and answers `page:frames` (or `page:failed`, asked again after 2 s), and from
  that answer on the room sends that browser the page's frames with their HTML (`Conn.pages`), since the room
  sends in order on one socket and nothing written after the read is missed; frames on the other pages it knew
  at the join come as metadata (`forPages`), and a page made since comes whole (`Conn.joinedPages`). A room
  message rather than a REST route for that reason. The browser keeps the pages it read; `stalePages` are the
  ones `init` left out and any a frame arrived on without its HTML, and a rejoin marks every page but the one
  `init` sent stale, so a page is never shown from an old copy; an `init` without `loadedPageIds` (a server from
  before page loading) is every page whole. The browser tells the room the pages on screen (`pages:shown`:
  the editor's page and the pages of frames `showFrames` registers, a prototype's screens), which it asks
  for whenever they are not here, after a failed read too, and the room keeps in memory while they are up. `usePageCanvas` /
  `currentPageCanvas` leave a page's frames out until it is ready (`pageReady`), the Stage says "Loading page…"
  and fits the page once it is there (a fly-to a frame there glides to its box at once and keeps it). Work on
  frames that may be elsewhere waits for their pages (`loadPages`; `loadFramePages` follows each frame to the
  page it is on, and rejects if one is deleted or the canvas changes): a client-drawn export of a frame not on
  screen (`frameRaster.ts`), undo and redo of an HTML or layer-name step and deleting a frame (`history.ts`, so
  undo brings back the real design); `copyFrames` copies nothing while one's page is on its way, the Inspector's
  HTML field is read-only and empty until then, and `api.updateFrame` refuses HTML for a frame whose page is
  not ready, so a blank or stale copy is never saved.
  A join without `pagesOnDemand` (the native apps, a tab on an older bundle) is sent the whole canvas and every
  frame's HTML, and pins every page while it is in the room. Tests: `pageLoadingHttp.test.ts`,
  `pageLoadingBrowser.test.ts` (fixture `tests/fixtures/pageLoading.html`, the room played by the test), `pageWaits.test.ts`, `deletePageLoading.test.ts`,
  `inspectorPageLoading.test.tsx`.
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
  WebKit (Safari, the Linux desktop app) rasterizes a composited layer at its CSS size, so a transform-only
  scale went soft past 100%. Both engines tile what is on screen, so backing memory follows the
  viewport, not k. From 300% a 1px pixel grid fades in over the frames (full at 500%): the
  Stage draws it over the bare paper, under the world, and each frame draws its own over its
  document and under its chrome (`PixelGrid.tsx`, faded by `--pixel-grid`), so pins, threads,
  grips, cursors and guides stay above it. Tests: `pixelGridBrowser.test.ts`. Frame
  names sit inside their frame, counter-scaled by `--zoom`, so they keep size and gap at every
  zoom and stack with their own frame (a later frame covers an earlier frame's name, never the
  reverse). The selected frame's size badge lives in a screen-space layer (`FrameLabelLayer`),
  placed from `--vx`/`--vy`/`--zoom`. ⇧1 / ⇧2 (fit all / fit selection), frame deep links and
  fly-tos fit into the stage area the top bar and floating panels leave open: `CanvasPage` passes
  `Stage` the `insets` its chrome covers and `fitBox` (`src/lib/viewFit.ts`) centres there.
  Tests: `viewFit.test.ts`, `fitSelectionBrowser.test.ts`.
- Following (`src/lib/follow.ts`, the loop in `Stage.tsx`, `FollowFrame.tsx`): every face in the
  presence stack is a toggle. A person is followed by their camera (`cameraToFollow`). An agent is
  followed to the frame it works on (`agentFollowFrame`, by `locatePresence`), fitted into the open
  stage, onto its page first, and again whenever that frame changes, moves or grows. Agents leave
  the roster whenever they go idle and come back as the same `agent:<name>` clientId, so an agent
  follow outlives that (`followedAgent` keeps it named; the pill says it is idle) and ends only on a
  camera move of our own, Esc, the pill's ✕ or another canvas. Tests: `follow.test.ts`.
- View options (`src/lib/viewOptions.ts`, per browser under `doop:view-options`): the zoom pill's
  menu opens on a field for a typed level (`150`, `150%`; `parseZoomPercent`) and switches the
  pixel grid (⇧'), other people's cursors (⌘⌥\ / Ctrl+Alt+\) and the comment pins (⇧C), each read
  by `code` (registry actions `pixel-grid`, `comments`, `cursors`). Hidden pins still show under
  the Comment tool and for a thread that is open. Tests: `viewOptions.test.ts`, `zoomMenu.test.tsx`.
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
  `Stage` paints it and a standalone drawing takes its ink from that tone.
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
  the brackets treat it as a frame, and ⌘A skips stack-locked shapes (`isStackLocked`). In the Layers panel ⇧/⌘-click on a
  top-level row (frame or canvas shape) adds it to the selection or drops it, as ⇧-click does on the canvas,
  and ⌫ in the tree deletes every selected one. ↩ and Tab act only when no control has the keyboard (`isControlTarget`) and
  something is selected, so buttons, menus and the Layers tree keep theirs. The bracket chords are
  read by `code` too, since ⌥ changes the typed character on macOS. Tests: `selectionKeys.test.ts`.
- Canvas commands (`src/lib/actions/`): every editor command is one entry in `registry.ts` (id,
  label key in the `actions` catalog, menu and section, chords, `edit`, `enabled`, `checked`,
  `run`), and the keyboard (`dispatchActionKey`, called first by `CanvasPage`'s keydown), the ⌘K
  palette (`CommandPalette.tsx`, cmdk through `ui/command.tsx`; text that names no command goes to
  the agent's composer as a prompt), the main menu off the bar's Doop mark (`MainMenu.tsx`: Go to files, then File,
  Edit, View, Object, Text, Arrange, Help) and the ⌃⇧? sheet (`ShortcutsSheet.tsx`) all read it.
  The layer right-click menu (`ElementContextMenu.tsx`) is mostly registry rows (`ActionMenuItem.tsx`),
  ordered as Figma's and Paper's (select, clipboard with a Copy/Paste as submenu, structure, stacking,
  flip, visibility); a right-click inside a multi-pick keeps it. A Layers row opens the same menu the canvas
  does (a shape's row too). No menu renames: a Layers row is renamed by a double-click. With several canvas shapes
  selected, a shape's Copy and Cut take them all, as ⌘C and ⌘X do (`cutFrames`). Frames and standalone shapes get Move to
  page (`MoveToPageMenu`). ⌘L copies a link and ⇧⌘C a PNG of the selection.
  `CanvasPage` lends the registry its modals and panels as the `ActionHost`. Chords (`chords.ts`)
  are `mod` (⌘ on a Mac, Ctrl elsewhere), ⌥ chords by `code`, `macOnly` / `notMac` per platform (⌘Y
  is outlines on a Mac, redo elsewhere), `global` for the two that act from fields (⌘K palette, ⌘/
  agent; a bare `/` opens the agent outside fields). A chord whose command is disabled or finds
  nothing falls through to the browser. ⌫, Esc, ↩/Tab and the arrows stay in `CanvasPage`'s own
  handler (their rules are shown, `hintOnly`). What the commands do lives in `edits.ts`: align /
  distribute / tidy / pack (`arrange.ts`, pure geometry) move frames as one undo step
  (`patchFrames`) and layers through the runtime's `move` geometry edit; ⌘G / ⌥⌘G wrap sibling
  layers in a `div` (carrying a flex parent's flow; grid children are refused; a frame edited while
  its layout is read is left alone) and ⇧⌘G / ⌘⌫ unwrap (`groupElements` / `ungroupElements` in
  `layers.ts`); ⇧A makes a box a flex container, or wraps the pick in one, turning the space between
  the layers into `gap` and dropping their flow margins so nothing moves; ⌥⌘C / ⌥⌘V copy and paste
  computed looks (`doop:computed`), text styles only between text layers; ⇧⌘V / ⇧⌘R paste over or
  replace the selection from the canvas clip (a frame goes only once all its replacements land; one
  undo step, a single `transfer` (`replaceFramesTracked`), so undo never removes a replacement
  before its original is back; tests in `replaceFrames.test.ts`); ⇧⌘U links (`setElementLink`: an
  image or SVG is wrapped in the link, other layers' content is); ⌃C is the EyeDropper. ⌘F / ⌥⌘F is
  the find bar (`FindBar.tsx`, `findText.ts`: text nodes only, locked layers found but never
  replaced, replace-all is one undo step across frames). View toggles: ⇧' / ⇧C / ⌥⌘\ switch the view
  options (pixel grid, comment pins, cursors), ⌘Y outline mode (an adopted sheet in each frame's
  runtime, never saved or exported), ⌥L collapses the Layers tree. N / ⇧N zoom to the next frame in
  reading order, Home / End bring it into view, PgUp / PgDn change page. Tests:
  `actionRegistry.test.ts` (no chord bound twice per platform, nor over a tool key),
  `actionChords.test.ts`, `arrange.test.ts`, `groupLayers.test.ts`, `findText.test.ts`.
- `src/lib/tools.ts` defines bottom-toolbar tools and shortcuts. `Stage.tsx` delegates drawing
  gestures and world-space previews to `CanvasDrawing.tsx`; Space/middle-button panning takes
  precedence over drawing.
- Zoom tool (Z, keyboard only; math in `src/lib/zoomTool.ts`): a click doubles the
  zoom about the pointer, ⌥-click halves it (the cursor turns to zoom-out while ⌥ is down), and a
  drag zooms onto the box it draws, filling the stage's open area. Z is the tool only while held:
  letting go returns to the previous tool, and the tool rail has no button for it.
  Tests: `zoomTool.test.ts`, the Zoom cases in `tools.test.ts`.
- Layers placed by hand (`src/lib/groupLayout.ts`): a shape drawn into a frame is
  `position:absolute; left; top; width; height`, and moving an absolute layer (drag, nudge, X/Y)
  rewrites its `left`/`top` (`moveByOffsets` in the runtime) instead of adding a `translate`;
  layers in flow still move by `translate`. ⌘G / ⌥⌘G / ⇧A on layers that all sit absolute make one
  absolute group marked `data-doop-drawing="group"` where they were: a flex row or column
  (`planGroup`: direction from the wider run, gap the mean space, `align-items` the shared edge,
  children reordered to the flow and given `flex-shrink:0`) when they do not overlap along it, else
  pinned (an absolute box of their bounds, children re-based). Layers in flow keep the
  flow-carrying group. ⇧⌘G on an absolute group puts its layers back absolute where they show. Shapes on the canvas
  (`src/lib/canvasGroups.ts`): ⌘G on two or more unlocked, unturned standalone shapes of one page keeps the
  frontmost one's frame (its id, comments, versions and stack place) and moves the others' layers into it,
  inside one `data-doop-drawing="group"` layer placed by percentages so the frame's grips scale them; the
  others' frames go, all as one undo step (`recordShellRewrite`). A shape whose frame would go is refused
  when it carries comments or a component main. ⇧⌘G on such a group gives each layer a frame of its own
  just behind, the group's frame keeping the frontmost. Every write is conditional: a shape a teammate edited
  meanwhile stays on the canvas and leaves the group (`keepShell`), and the step is `guarded`: undo or redo
  refuses once someone else (as the room reports, `src/lib/theirSaves.ts`) has saved a frame it would overwrite or delete since its own save (`noteSaved`); this browser's later steps and their undo do not count. It checks again before each write, and each write is conditional on the newest version this browser knows, so a save landing meanwhile is a conflict, not overwritten. Refused
  too: moving the frame's corner under comments pinned to the frame (they are frame-relative), splitting a
  group turned or flipped as a whole, and splitting one whose wrapper has comments; a hidden group splits into hidden shapes. A split is tracked whole, so an undo pressed meanwhile waits for it, and
  it selects the new shapes only if the selection and page are still the ones it started from. Tests: `canvasGroups.test.ts`. A
  click picks the outermost canvas group around the hit, a double-click on a picked group goes one
  level in, and with a layer inside picked clicks pick its siblings (`groupLevel`); comments still
  pin to the element under the pointer. Drops (`src/frame-runtime/drop.ts`, canvas drags of layers and
  of shapes on the frame, and Layers panel moves through `layerPlacement`): into a flex or grid box
  an absolute layer becomes a flow item; into a box that places its layers by hand (`freeform`:
  the body, a canvas group, or a box already holding absolute layers, with nothing else in flow)
  it goes absolute where it was let go; a canvas group left empty is removed. A layer placed by its
  own inline styles has them removed on a flow drop; only a stylesheet-placed one gets the
  `position: relative !important` override. Tests: `groupLayout.test.ts`, `groupDrawnBrowser.test.ts`,
  `layersMove.test.ts`.
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
- A vector's stroke spills past its box, as in Figma (`src/lib/frameBleed.ts`,
  `src/frame-runtime/bleed.ts`): a drawn path's `<svg>` paints its overflow (a runtime sheet), and a standalone
  shape's iframe, which can paint nothing past its own edge, reaches a margin past the frame on every
  side. The runtime asks for it (`doop:bleed-want`, half of the widest stroke past the box through the
  shape's transform, a miter join or square cap further, in 16px steps up to 1024) and insets its body
  once `FrameView` has grown the iframe (`doop:bleed`); the surface stops clipping a standalone, and the
  margin takes no pointer events. Everything the runtime says or hears stays in the frame's design px:
  only its viewport calls (`elementsFromPoint`, `caretRangeFromPoint`, `getBoundingClientRect`, event
  `clientX`, `innerWidth`) see the margin, and editor code measuring the iframe element takes it off
  (`documentRect`, `iframeBleed`). W/H stay the path's geometry. Server renders and exports still clip
  at the frame. Tests: `vectorPaintBrowser.test.ts`, the thick-stroke case in `drawingShapesBrowser.test.ts`.
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
- `ElementMove.tsx` moves a drawing as an unclipped copy under the pointer and highlights the
  destination frame; the original is hidden in its frame (`doop:drawing-moving`) once the copy
  paints, and the copy stays until the frames show the save, so the shape itself follows the drag.
  While anything moves (a drawing, a layer, a standalone shape) its outline, grips and size badge
  stay hidden. Drawings and layers snap to their frame's edges and centre, their parent box and
  their siblings (`snapRects` on the runtime's hit replies) as well as the ruler guides.
  Ordinary HTML/SVG layers move in place through the runtime's geometry/style gesture bridge,
  preserving layout and transforms and committing one undo step per drag. A drag on one of
  several picked layers (or inside one) moves them all: the rest ride the gesture as `followers`
  (`styleGesture` `begin`), each translated by the pressed layer's delta, put back on Escape and
  saved with it as one step; a multi-pick never takes a layout drop, and the pressed layer
  becomes the pick's primary.
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
  grips. An edit is not an interaction: while the runtime morphs in a new version of the html,
  applies any style (Design panel values, rotation and flip, nudges) or holds a style gesture
  open, an adopted sheet (`holdStill` / `releaseStill`) sets `transition: none !important` on
  everything from a cascade layer, which outranks a design's unlayered `!important` (an inline
  `!important` transition still wins), so an element under
  `transition: all` jumps to its new box, tracks the pointer, and is outlined at the size it
  settles at; the design's own transitions are back once the edit lands.
  `tests/elementResize.test.ts` covers the geometry and `tests/elementResizeBrowser.test.ts`
  drags the grips in Chromium.
- A selected frame wears the same furniture as a selected element (`FrameResizeHandles.tsx`,
  geometry in `src/lib/frameResize.ts`): a grip in each corner, grabbable edges, a two-pixel
  ring, all in screen px at every zoom, and a `W × H` badge under the frame in the label layer.
  A west or north pull moves that edge and keeps the far one still; Shift keeps the ratio; the
  dragged edges snap to neighbours and guides (`snapFrame` takes the handle). Frames go down to
  1×1 (`MIN_FRAME_SIZE`, also the Inspector's floor). `tests/frameResize.test.ts` covers the
  geometry, `tests/frameResizeBrowser.test.ts` drags the grips in Chromium.
  The frame Inspector's X / Y / W / H are the same `NumberField` the element panel uses
  (`src/components/ui/property-field.tsx`): the field's icon is the drag handle, the unit when it
  has none (`useValueScrub`, `data-scrub`; Shift ×10, Alt ×0.1, Esc cancels) and ↑/↓ nudge. A drag
  previews every step through `patchFrameLocal` and, through `PropertyScrubContext`, commits once
  on release as one discrete undo step and one PATCH; Esc puts the frame's box back and saves
  nothing. A field given `slider={[min, max]}` (element and fill opacity, corner radius) is also a
  slider (`useValueSlide`): hover shows the value as a fill and thumb across the field, and a drag
  anywhere else on it moves the value by the share of the width travelled (never jumping to the
  pointer); a click still types, mouse and pen only. Tests: `inspectorScrub.test.tsx`,
  `valueSlide.test.tsx`.
- Frame fill (`FrameFillSection` in `Inspector.tsx`, `rootFill` in `src/frame-runtime/inspect.ts`): the frame
  Inspector has a Fill section, as a Figma frame does, and it is the element panel's own
  (`FillSection` in `ElementPanel.tsx`: colour, opacity, token binding, image fill). It edits the
  background of the root element that paints the frame, read live through `doop:root-fill`:
  `<body>`, whose paint covers the whole frame while `<html>` has none, unless `<html>` is painted
  and the body is not, or covers under half the frame (a centred column). A colour edit replaces a
  gradient over it (`background-image: none`) and a token set through the `background` shorthand
  (shown as bound). Reads take a ticket so only the newest answer lands; until the frame answers
  the section says so. Writes are ordinary runtime style edits (`styleElement` / `styleGesture`),
  saved and undone like any other. Not shown for a locked frame or a standalone shape. Tests:
  `frameFillBrowser.test.ts`.
- Frame rotation (`shared/frameRotation.ts`, `src/lib/frameRotate.ts`): a selected frame wears a
  zone just outside each corner (`data-frame-rotate-handle`, 18 screen px, clear of the corner
  grip) that shows Figma's curved double-arrow cursor, turned to curve around its corner and with
  the frame's own rotation (`rotateCursor`, tagged `data-cursor="rotate"`). A drag there turns the
  frame about its centre with the pointer (`startRotate` in `FrameView.tsx`; Shift snaps to 15°,
  Esc puts it back), broadcast live as `frame:drag`'s `rotation` and saved once on release as one
  discrete undo step. `Frame.rotation` is degrees clockwise about the centre, stored in
  `frames.rotation` (migration `0048_frame_rotation`) normalised to (-180, 180] with 0 unset;
  `x`/`y`/`width`/`height` stay the unrotated box and the wrapper carries `rotate()`, so the
  frame's name, grips and pins turn with it. The Inspector's Layout group has the rotation field (Lucide's `Angle` icon), the
  size badge sits under the turned bounds, and a press inside a turned frame
  is turned back into design px (`unrotatePoint`, `frameDesignPoint` for the element move hook and the
  path editor's `frameTurnMatrix`) before the runtime is probed; the frame's own grips pull along
  its axes with the far corner held still (`keepAnchorTurned`) and do not snap while turned. MCP `update_frame`
  takes `rotation` through `server/pageTools.ts` (normalisation and page validation), and
  `get_canvas` lists it when set; copy, paste and duplicate
  (`frameClipboard.ts`) carry it. A drawing dragged in, out of or between turned frames lands
  through `turnedDropRect` (its centre carried through each frame's turn), and a turn whose frame,
  page or canvas goes mid-drag ends unsaved. Not yet turned: marquee selection,
  snapping and exports read the unrotated box. Tests: `frameRotation.test.ts`,
  `frameRotationHttp.test.ts`, `frameRotateBrowser.test.ts`.
- Element rotation (`src/lib/elementRotate.ts`): an element inside a frame wears the same rotate
  zones (`data-rotate-handle` in `ElementResizeHandles.tsx`); a drag there turns it about its centre
  through the runtime's `rotate` geometry edit inside a style gesture (preview per move, one
  discrete save on release, Shift snaps to 15°, Esc cancels), the same way the Design panel's
  Rotation field sets it. The runtime reports an element's own turn (`ownRotation`: its `rotate`
  plus a plain 2D `transform` angle; skew, flip and 3D stay out) and its box before that turn
  (`box`, via a uniform render scale read off the turned bounds) in hit info, `inspect` and
  `doop:locate`; `selectionBox` draws the outline, grips and zones on that box, centred on the
  bounds and turned with it, so a turned layer keeps its grips and resizes along its own axes
  (`derotateDelta`; no guide snapping while turned). `sizable` now admits the element's own turn
  and still refuses a turned, skewed, 3D or nonuniformly scaled ancestor; unsupported transforms
  use the axis-aligned rendered bounds for the selection outline. Tests: `elementRotate.test.ts`,
  `elementRotateBrowser.test.ts`, the turned cases in `elementResizeBrowser.test.ts`.
- Distances (`src/lib/measure.ts`, `src/lib/measureKey.ts`, `src/components/MeasureOverlay.tsx`): holding ⌥
  with the Select tool and something selected shows, as Figma does, red lines labelled with the distance
  from the selection to what the pointer is over. The picked elements are measured, as one box, to the
  element under the pointer in their frame (the runtime's `doop:measure`, `measureElement` in
  `frameBridge.ts`), or to the box around the primary one (its parent, the frame for a root layer) when
  the pointer is on one of them; selected frames are measured, as one box, to another frame under the
  pointer, which is also what a picked element's frame gets once the pointer is over another frame.
  Boxes that overlap are measured edge to matching edge, boxes apart across the gap, with a dashed
  extension of the target's edge when it is off to one side (`measureBetween`, pure). The overlay lives
  in the Stage's world and reads at most once a frame, on pointer events and on changes to the canvas,
  selection or camera; nothing shows during a drag, while typing in a field, or with ⌘ / Ctrl held, and
  letting ⌥ go over the canvas does not open the browser's menu bar. Turned frames and layers are
  measured by their bounds. Tests: `measure.test.ts`, `measureBrowser.test.ts`.
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
- `tests/drawing.test.ts` covers geometry, serialization and persistence. Four browser files
  exercise the toolbar and gestures in Chromium on one shared page setup (`tests/drawingPage.ts`):
  `drawingShapesBrowser.test.ts` (the tools, Bézier paths, text, mobile input),
  `drawingMoveBrowser.test.ts` (dragging and copying layers, cancellation),
  `drawingReorderBrowser.test.ts` (groups, reparenting, reordering, delayed hit-test replies) and
  `drawingGeometryBrowser.test.ts` (transformed shapes, stacking, canvas comment pins and reply
  fields). They are separate files so CI's shards can share them out: vitest assigns a file to a
  shard by the hash of its path, and these four names land in four different shards.
  `tests/drawingMove.test.ts` covers transfer persistence, locks, failed saves and rollbacks,
  creation queued with transfers, and undo/redo. Browser regressions cover transformed shapes,
  stacking contexts, covered shapes, and delayed hit-test replies.

- Comment anchors (`shared/comments.ts`): an element comment is `frameId` + `elementId` (the
  element's `data-doop-id`) + `snippet`; a frame comment is `frameId` + design-px `x`/`y` and no
  `elementId` (the Comment tool makes one on the frame's background, or from its name, which
  outlines the whole frame on hover and pins the comment just inside its top-left corner); a canvas comment is `pageId` + world `x`/`y`. One whose element is gone keeps the
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
- People in comments (`shared/personMentions.ts`, `server/canvasPeople.ts`, `src/components/MentionPicker.tsx`):
  a mention is `@` plus the person's account name in the text (`@Ana Souza`, longest name first,
  no case, a name ends where no letter, combining mark, digit or `_` follows). Typing `@` in the
  composer, a thread reply or the Comments panel's reply lists the canvas's people (owner,
  members, workspace members, from `GET /api/canvases/:id/people`, comment role, names and faces
  only, asked again whenever a field mounts) and, for editors, its agents; the thread draws
  mentions in brand. Names are not unique, so the picker sends the ids it picked as `mentions`
  beside the text (the latest pick of a name in the draft; an agent picked over a person
  named like its handle rides as `agent:<id>`, so the agent gets it). The routes, MCP `reply_to_comment` and the resident's reply resolve the text
  once (`resolveCommentMentions` → `resolvePersonMentions`) against everyone eligible (those
  people plus the thread's authors) before any filtering: a name several people share reaches
  only the picked ones, and nobody when none was picked. The result's `roleText` (people
  blanked out) is what the agent matcher, the edit-access check and the meter read, so
  `@Doop Fan` is not `@doop`; the resident strips agent mentions only outside people's
  (`withoutAgentMentions`). The ids ride the `comment.created` / `comment.replied` event, and
  `commentNotifications.ts` emails each at once (`mentionEmail`) and leaves them out of that
  comment's digest. The author, someone who switched comment emails off, a banned account or
  someone who lost access is not written to. Comment links (`src/lib/commentLink.ts`, the shape
  of `server/links.ts`'s `commentLink`): "Copy link to comment" on a pin's right-click menu, an
  open Comments panel row's, and the link button on a thread's first message. Opening one,
  `Stage` follows the root to its current frame, not the one the link names. Tests:
  `personMentions.test.ts`, `commentLink.test.ts`, the `@mentions` cases in
  `commentNotifications.test.ts`, the picker cases in `commentsPanel.test.tsx`, the mention and
  `/people` cases in `canvasCommentsRoute.test.ts`, the person case in `residentComments.test.ts`.
- Chat in the Agents tab (`src/components/AgentChat.tsx`, `src/lib/agentChat.ts`): under Recent
  tasks, each composer prompt (a board card without a `kind`) and any feedback left on it is a
  turn, oldest first, with the agent's answer under it: waiting, working, the run's closing words,
  or the failure reason. A finished resident run keeps those words on the cards and feedback it
  handled (`actions.recordWorkReply`, `reply` on `tasks` and `feedback`, migration 0056; a later
  pipeline stage replaces an earlier one's), so the answer survives a reload. The line between
  Recent tasks and the chat drags, ↑/↓ on focus, double-click resets (`src/lib/agentsSplit.ts`,
  per browser under `doop:agents-split`). Recent tasks scrolls itself, its Show all / Show less
  toggle pinned to its bottom edge in every state, and collapsing scrolls it back to the top.
  Tests: `agentChat.test.ts`, `recentTasksBrowser.test.ts`.
- Comment pins move by drag (`src/lib/commentMove.ts`, gesture in `CommentPin`): anyone who may
  comment drags a thread's root pin; a ghost rides the pointer in the world layer
  (`CanvasComments`), above every frame, since the pin itself sits inside a clipped frame surface.
  On release the drop point is resolved in order: the topmost visible frame under it is probed
  (`doop:probe`) for an element, else the frame as a whole at that design point, else the canvas
  at that world point, so a thread changes kind either way (element → canvas comment and back).
  `PATCH /api/comments/:id/anchor` (comment role; `CommentAnchorInput` in `shared/comments.ts`)
  re-anchors the root and its replies together and broadcasts each; a drop on the same anchor
  sends nothing, Esc mid-drag puts the pin back. Tests: `commentMove.test.ts`,
  `canvasCommentsRoute.test.ts`, `elementIds.test.ts`, the drag case in `drawingGeometryBrowser.test.ts`.
- Components (`.context/specs/components.md`): a main is an element marked `data-doop-component`; an
  instance is full markup marked `data-doop-instance`, so frame consumers need no changes. Every
  frame write passes `prepareFrameHtml` (`server/components.ts`): `<doop-use>` expands, a changed main
  becomes a revision, instances reconcile against the revision they were rendered from
  (`server/componentEngine.ts`) and upgrade. A frame's row holds an instance as a reference, rendered
  from its component when the frame is read (Compact frame storage, under Design tokens), so a changed
  main rewrites no frame: the queue (`server/propagation.ts`, `actions.queuePropagation`) renders the
  frames in memory again, one per tick, and loads or holds no canvas for it. The components pass runs
  first on every write, then `withLibraryFaces`, so an expanded
  `<doop-use>` naming a library family gets its face. A component's stylesheet and head tags are
  composed into a frame where it is rendered, not stored in it (Lean frame storage, under Design
  tokens), so a change to its rules alone writes no frame using it. A definition's `renderRev`
  (`components.render_rev`, migration `0063_component_render_rev`, null meaning `rev`; set by
  `store.saveComponent`) is the revision its template or props last changed at: instances are
  marked with it, a rules-only revision raises `rev` alone, "behind" everywhere (a frame read from
  storage, propagation) means a mark older than `renderRev`, and `stateAtRev` finds the base for a stale
  save by the span of revisions (`renderRev`..`rev`) a kept state covers, so rules-only revisions
  using up the 20 kept never strand an instance. Agents read and write the short form
  (`get_frame`, `edit_frame_html`); tools live once in `server/componentTools.ts` for MCP and the
  resident agent. `get_component_preview` and the resident's `screenshot_component` show the default
  instance, or compare selected prop values in one image (up to 12 combinations). Omitted props keep
  their defaults. `src/lib/components.ts` and `ComponentsPanel.tsx` (the Layers panel's Components
  tab, beside Tokens) / `ComponentSection.tsx` are the editor's side. A component is renamed from its card's menu
  or a double-click on its name in that tab, or from its main's Layers row (`renameComponent`; instances are
  linked by id, so they follow). As in Figma, renaming an instance's row names that layer
  alone (`data-doop-name`, kept as an override of that instance, still linked). Stored in `components`
  (migration `0052_components`), one small row per definition; its earlier revisions are rows of
  `component_revisions` (migration `0062_component_revisions`, backfilled from the retired inline
  `components.history` column, which a later migration drops): inserted once, never updated, the
  newest 20 kept, written by `persist.saveComponent` inside the component's write queue and loaded
  at boot into `ComponentDef.history` for the stale-save merge. Browsers get a `WireComponentDef`
  (no `history`) in `init`, `component` messages and REST;
  `GET /api/canvases/:id/components/:componentId/revisions` lists them. Tests:
  `componentRevisions.test.ts`, `componentRevisionsHttp.test.ts`. Tests: `components.test.ts`, `componentsEdgeCases.test.ts`,
  `componentTools.test.ts`, `componentsRoutes.test.ts`, `componentsBrowser.test.ts`. A bare
  `data-doop-prop="name"` binds an element's text, except where there is none: on `img`, `source`,
  `video`, `audio`, `iframe` and `embed` it binds `src`, on `input` its `value` (`parseBindings`
  takes the tag). A `<doop-use>` that renders nothing is reported, never dropped quietly: a main with
  no markup (`empty_template`), and on a whole write one never closed (`unclosed_use`), which is
  placed with no slot content so the ones after it still expand (mid-stream it waits for its
  end). That placement is a person's only (editor, REST `/append`, an idle stream's settling): an
  agent's whole write is refused instead (#528), from the engine's own report
  (`prepareFrameHtml`'s `refuseUnclosed`, set by `updateFrame`, `createFrame` and a stream's `done`
  chunk for agent actors, override markup included; `changeInstances` likewise), and a component
  template by `refuseUnclosedTemplate` (`unclosedUses`, the same scanner). The refusal is a
  `WriteRefusedError` (`server/writeRefusal.ts`): the operation undoes the write, and the MCP tool
  wrapper (`toolLoads.ts`), `runComponentTool` and the resident's tool call answer with its message.
  Slot and override markup is whole, so it always expands as a whole write, mid-stream too
  (`expandOverride`, its issues `inOverride`): a stream chunk whose override leaves a use open is
  refused at once, since no later chunk closes it. A refused chunk leaves the stream open, its idle
  clock restarted. Mid-stream, the streaming
  agent's own edit is not a whole write; another agent's is refused unless it replaces the design
  (`replace`: MCP and resident `set_frame_html`, the resident's rewrite commit). The scanner skips
  `<doop-use` text in scripts, styles, textareas, titles and comments and in names like
  `<doop-user-chip>`. Tests: `componentDrops.test.ts`, the `<doop-use>` cases in `inlineData.test.ts`. A component's CSS is read with CSS escapes honoured (Tailwind's `\'` in
  `[class*='size-']` is part of a class name, not a string); a sheet that still cannot be read to the
  end (a string or block left open, text outside a rule) is reported as `css_not_read` with where it
  went wrong, beside `css_unmatched`. The CSS written for a component (its `data-doop-component-source`
  block) is kept apart from the page's: a rule of it naming nothing in the main is kept, scoped by
  its subject, when it is anchored to the component (a state, a script-added element), and left out
  as `css_not_kept` when not (`extractComponentCss`'s `own`, `sortUnmatched`, #517). Tests: `componentCssEscapes.test.ts`,
  the state and script-added cases in `componentTools.test.ts`.
- Component system first (`SYSTEM_FIRST`, `COMPOSE_CHECK` in `server/guide.ts`): the guide opens
  with a must-do list (tokens, then a component system set up the way a designer sets up a Figma
  file, then screens composed from it; themes are tokens, never a copied frame), the brief creates
  the kit after the tokens, and `COMPONENTS` asks for components by judgment (primitives and the
  patterns a product reuses, from the first copy) instead of after a third copy. `create_frame`,
  `append_frame_html` and `set_frame_html` (and the resident's create, set and rewrite tools) end
  their descriptions with the check. `create_components` (`server/componentTools.ts`, MCP and
  resident) makes up to 12 components from markup in one call, in order so a later one nests an
  earlier one, each entry its own unit (a refused one is reported, the rest are made). The
  `COMPONENT SYSTEM` notes (`componentSystemPlan`, `componentSystemNotes`): an empty `create_frame`
  hears to set up the system or compose from it; a product screen (8+ elements with a control,
  link, nav or form; never a main, a Components-page frame, a canvas shape or a demo) written with
  no instance hears that the canvas has no system, or which components it ignored. Mid-stream it
  is said once per stream (`streamChunkNotes`), on the first chunk that shows a screen. Notes go
  right after a result's data, ahead of the generic nudges. Tests: `reuseNotes.test.ts`, the
  `create_components` cases in `componentTools.test.ts`, `tokenComponentGuidance.test.ts`.
- Reuse notes (`server/reuseNotes.ts`): a whole-frame write (MCP `create_frame`, `set_frame_html`, the
  `done` chunk of a stream; the resident's `create_frame`, `set_frame_html`, `commit_frame_rewrite`)
  gets `componentWriteNotes(frame, { review: true })`, which adds what the frame should have reused:
  a block written out three or more times (`REUSE`: make one a component with `create_component`,
  then replace the other copies with `<doop-use>` through `edit_frame_html`), colours the canvas has as tokens (`TOKENS`, `#hex → var(--name)`, aliases resolved), a
  colour palette declared on `:root` or tokens redefined there, and on a canvas with no tokens a frame
  hardcoding four or more colours. Doop's own blocks (tokens, fonts, component CSS) are not counted;
  `edit_frame_html` stays quiet. `create_component` / `update_component` name rows a main repeats by
  hand (make one a component, `<doop-use>` it in the main) and what `auto_props=false` costs.
  `get_canvas` and the resident kickoff say a canvas has no tokens yet (`NO_TOKENS_BRIEF`).
  `upload_asset` states its per-minute limit and its refusal says when to retry. Tests:
  `reuseNotes.test.ts`.
- Adding to an established canvas (`server/existingStyle.ts`): on a canvas with two or more of the
  user's frames (demo frames and the Components page left out), `get_canvas` carries `existingStyle`
  and the resident kickoff an "Existing style" block: with no tokens, the colours and fonts the
  frames share (by how many frames name each). The brief (`existingStyleBrief`, replacing
  `NO_TOKENS_BRIEF` there) asks for tokens from those values before the first new frame, and says to leave the existing
  frames alone unless asked, offering the clean-up at the end;
  `DESIGN_BRIEF` and `COMPONENTS` say the same. Tests: `existingStyle.test.ts`.
- Workspace component libraries (`.context/specs/workspace-component-library.md`,
  `server/componentLibrary.ts`): a workspace canvas publishes snapshots of its components
  (`library_components`, migration `0053_library_components`, mirrored in memory) and every other
  canvas of the workspace can use them. Using one adds a linked definition with no main
  (`source.library`), by `import_component`, by a click in the Components panel, or by a write
  naming it (`contextFor`'s `LibraryAdoption` in `prepareFrameHtml` / `prepareChunk`); the tokens it
  names come along (`actions.announceAdopted`). Updates wait until `sync_component` pulls them.
  `update_library_everywhere` (`updateLibraryConsumers`) is the one explicit push: it loads each canvas
  that is behind and pulls there. `workspaces.library_publish` (migration `0054_library_publish_policy`)
  can keep publishing, and that push, to the owner and admins.
  `libraryBlock` is the entitlement (a canvas in an active workspace; every workspace with billing
  off), refused as a 402 the panel turns into `LibraryUpgradeFlow`, which resumes after Stripe
  Checkout from a per-browser note (`src/lib/libraryResume.ts`). A workspace can keep publishing
  to its owner and admins (`workspaces.library_publish`, migration `0054_library_publish_policy`,
  set in the Workspace page's General pane; `requireLibraryPublisher`, a 403). Agents: `publish_library`,
  `workspaceLibraries` in `get_canvas`. Editor: `LibrarySection.tsx`, and the Workspace page's Libraries pane
  (`WorkspaceLibraries.tsx`). A library canvas opens on its components: the canvas GET and the
  room's `init` carry `landingPageId` (`landingPageOf`; `libraryLandingPageId` in
  `shared/pages.ts`: the page holding the most published components' mains, a tie to the page
  named "Components", then page order; unset when the canvas has published nothing or no
  published main is on a page), which the editor uses as the default page of a link naming none. Tests:
  `workspaceLibrary.test.ts`, `libraryTools.test.ts`, `librarySection.test.tsx`,
  `workspaceLibraries.test.tsx`, `libraryResume.test.ts`.
- Prototypes (`.context/specs/prototyping.md`): interactions are `data-doop-on` /
  `data-doop-action` (or the JSON `data-doop-interactions`) attributes in frame HTML, parsed by
  `shared/prototype.ts`, whose parser the frame runtime bundles too (`src/frame-runtime/proto.ts`). `PrototypePlayer.tsx`
  (Play, and the full-page `/c/<id>/proto`) runs them with Web Animations transitions, under the
  desktop tab strip (`--app-inset`), its controls in a bar above the screens (never over the design), scaled by the viewer's pick (actual size, responsive, fit width,
  fit, fill; `screenLayout`, remembered under `doop:proto-scaling`; Fit, the default, only ever
  shrinks, as Figma's "Fit width and height" does, so a phone screen on a big monitor stays at its
  design size, while Fit width and Fill still enlarge); the
  Prototype tab and `PrototypeOverlay.tsx` edit and draw them (every link while no frame is
  selected; with one selected, or an element picked in it, only the links into and out of it, as
  Figma does); MCP has `get_prototype` and
  `set_prototype_start`. `tests/prototypeBrowser.test.ts` drives the player in Chromium.

## 5. Security and Secrets

- better-auth 1.6.26 - authentication: email/password, generic OIDC/SSO, and Google / Microsoft /
  GitHub / Apple sign-in (social providers, `GOOGLE_*` / `MICROSOFT_*` / `GITHUB_*` / `APPLE_*` client pairs; the iOS app
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

- Account deletion: Settings → Your account ends with a Delete account card
  (`src/components/DeleteAccount.tsx`) and the iOS app has the same action; both call better-auth's
  `POST /api/auth/delete-user`, with the password when the account has one (`list-accounts` shows a
  `credential` provider), else on a fresh session. The `beforeDelete` hook
  (`server/accountDeletion.ts`) deletes canvases only that user could reach and leaves the rest.
  Tests: `accountDeletion.test.ts`, `deleteAccount.test.tsx`.

- Sign-in policy (`shared/instanceSettings.ts`, `server/instanceSettings.ts`): instance admins set,
  in Admin → Sign-in, whether visitors may sign up with email and password (off hides the form and
  the `/api/auth/*` mount refuses `sign-up/email` with `SIGNUP_DISABLED`; existing accounts still
  sign in, provider sign-ups are untouched), whether signed-out visitors go straight to the OIDC
  provider (`AuthPage` starts the round trip on mount; never after a provider error, under
  `?manual=1`, or in the desktop shell), and a default workspace every new account joins as a member
  (`joinDefaultWorkspace`, in the user-create hook, or on verification when SMTP is on, like
  invites). One row in `instance_settings` (migration 0050), read into memory at boot;
  `GET /api/oidc-config` adds the public half as `emailPasswordSignup` / `ssoAutoRedirect`;
  `GET`/`PATCH /api/admin/instance-settings` edit it (409 with a `refusal`). Auto-redirect is
  refused until an admin has signed in through SSO, so a provider nobody has proven cannot lock the
  instance out. Env keeps secrets and provider wiring only. Tests: `instanceSettings.test.ts`, the
  policy cases in `authFormBrowser.test.ts`.

- GitHub sign-in (`loadGithubConfig`, `fetchGithubIdentity` in `server/auth.ts`): on when
  `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are both set (an OAuth app, not the `GITHUB_APP_*`
  importer), reported as `github` by `GET /api/oidc-config`. The profile read is ours rather than
  better-auth's: the address is the primary one from `/user/emails` with its `verified` flag, which
  is what lets a sign-in link to an existing unverified account like the other providers do. The
  public profile address is never used, and a failed read of either endpoint fails the sign-in. It
  always reads github.com's API, not `GITHUB_API_URL`. Tests: `oidcConfig.test.ts`.

- MCP OAuth (better-auth `mcp()` plugin): 1h access tokens, 30-day refresh tokens
  (`MCP_REFRESH_TOKEN_TTL_S` in `server/mcpTokens.ts`; a refresh issues a new refresh token in a
  new row and never revokes the old one, which stays valid until it expires). A daily prune
  deletes expired token rows but keeps the newest per user and client, since `allowance.ts` reads
  any row as proof an agent once connected. Consent (`server/mcpConsent.ts`, a plugin of before
  hooks ahead of `mcp()`): the plugin's authorize shows `/oauth/consent` only on `prompt=consent`
  and registration is open, so `/mcp/authorize` is marked `prompt=consent` unless this person
  already approved this client for every requested scope (`oauth_consent` rows, written when they
  press Connect), and always when signed out; `/mcp/token` refuses a code still awaiting approval
  (the pending request is stored under the consent page's own code), and `/oauth2/consent`
  approves only for the person who made the request. Tests: `mcpConsent.test.ts`.

## 6. Build and Dependency Management

- Canvas access: `canvasRole` in `server/access.ts` gives owners, members and workspace members
  edit, and share-link visitors the link's level (`none` / `view` / `comment` / `edit`). REST,
  the WebSocket room and MCP gate reads, comments and writes on it separately; spec in
  `.context/specs/share-link-roles.md`. A workspace's admins can switch link sharing off
  (`workspaces.link_sharing`, migration 0065): every link in it reads as `none`, its canvases go
  private and leave the Community gallery, and new links and listings are refused
  (`link_sharing_off`).

- Bun 1.3.10 - package manager; lockfile at `bun.lock`, installed with `bun install
--frozen-lockfile` in CI.
- Vite 8 (Rolldown-based) - frontend build tool (`vite build`), with `@vitejs/plugin-react` 6.

## 7. Testing Stack

- Vitest 5 - unit/integration tests across `server/` and `src/`; run via `bun run test`
  (`vitest run`). Tests live in `tests/`.
- Browser tests drive one shared Chromium and one fixture server (`tests/browser.ts`), which
  `tests/globalSetup.ts` starts before any worker runs. The server hands out a production build:
  `tests/fixtures.vite.config.ts` is the app's own build with every `tests/fixtures/*.html` as an
  entry beside `index.html`, built once per run (about a second, as its own `vite build` process
  with `NODE_ENV=production`) into a temp directory and served by `vite preview`; there is no dev
  server and no live-reload client. A file calls `pagePerTest()` for a page per test in its own
  context (focus emulated, 30s navigation bound) and `fixtureUrl()` for its page. A fixture
  exposes what a test needs on `window`; a test cannot import `/src/...` from the page. A test of
  what the canvas page itself does mounts the real `CanvasPage` with no backend
  (`tests/canvasPageFixture.ts`: the room's socket stubbed, the session and API answered by the
  test). Only a test about what the server does starts one, and serves the same build in front of
  it with `serveBuilt(proxy)`: `pageControlsBrowser.test.ts`, whose subject is the room's broadcasts
  racing the HTTP responses and undo against the stored pages.
- CI runs the browser tests on the Chrome for Testing build named in `.chrome-version`, installed
  by the `test` job and passed as `CHROME_PATH`, so a runner image update cannot change the
  browser without a commit. `bun run test:linux [vitest args]` (`scripts/test-linux.sh`,
  `tests/linux.Dockerfile`, needs Docker) runs the suite in a two-CPU Linux container, for a
  test that fails on CI and passes on a Mac, and for the clipboard tests a Mac skips; on Apple
  Silicon the container uses Debian's Chromium, since Chrome for Testing has no Linux arm64 build.

## 8. CI/CD and Delivery

- GitHub Actions:
  - Runners: Blacksmith (`doop-design` org, app at app.blacksmith.sh). CI on
    `blacksmith-4vcpu-ubuntu-2404` (the trivial gates on 2 vCPU), the macOS desktop, iOS and Android
    builds on `blacksmith-12vcpu-macos-*`, the Linux desktop build on `blacksmith-4vcpu-ubuntu-2204`.
    Windows builds, `cla.yml`, `release-please.yml` and the desktop `release` job stay on GitHub's
    runners (Blacksmith Windows is in beta; the rest are seconds long). `actions/cache` and the
    setup actions' caches go to Blacksmith's cache transparently; no `useblacksmith/*` actions.
  - `.github/workflows/ci.yml` - gates `typecheck`, `lint` + `format:check` + `doc-lint`, `build`
    and `test` (four vitest shards) as parallel jobs on push to `main` and on PRs, cancelling
    superseded PR runs; a separate job lints the PR title with commitlint (PRs land on
    `main` as a squash, so the PR title becomes the commit subject).
  - `.github/workflows/cla.yml` - CLA check (this is an AGPL-3.0 project with CLA-based
    contribution).
  - `.github/workflows/publish-cli.yml` - publishes the doop CLI to npm as `@doop-design/cli` on a `cli-v*` tag
    ([RELEASE.md](RELEASE.md#doop-cli-npm)).
  - `.github/workflows/desktop.yml` / `desktop-release.yml` - Tauri desktop app CI and installer
    release (tag `desktop-v*`, universal macOS DMG, Windows NSIS, Linux AppImage/.deb/.rpm,
    optional Apple signing/notarization).

## 9. Infrastructure and Deployment

- Experimental Gemini cloud pilot: `server/geminiCloudRuns.ts` dispatches resident harness tasks
  to per-user workers; `server/geminiCloudMcp.ts` exposes run-scoped canvas tools. The standalone
  worker runs official Gemini CLI headlessly, with Google credentials retained in its own volume.
  `workers/gemini/Dockerfile` builds the worker. Setup and limitations: `docs/gemini-cloud-pilot.md`.
  `DOOP_GEMINI_CLOUD_WORKERS` enables operator-managed routing and BYO metering; unset by default.

- Stall watchdog (`server/stallWatchdog.ts`, watcher thread `server/stallWatcher.mjs`): every
  operation (`server/workBudget.ts` opens one per HTTP request, MCP or resident tool call and queued
  frame) is written into a `SharedArrayBuffer` when it begins and cleared when it ends, and the main
  thread stamps a heartbeat there every 500 ms. A `worker_threads` watcher logs one `[stall]` line
  naming the operations in flight once the heartbeat is older than `STALL_LOG_MS` (5 s), and past
  `STALL_EXIT_MS` (60 s in production, off elsewhere) logs them again and sends the process
  `SIGKILL`, since a hung process is never restarted by Railway and a blocked one cannot exit by
  itself (`process.exit` in a worker ends only the worker). It writes with `fs.writeSync(2)`: a
  worker's console goes through the blocked main thread. Debounced frame writes cannot be flushed
  in that exit. `[slow-op]` lines file any operation over `SLOW_OP_LOG_MS` (2 s) with the worst
  event-loop delay (`monitorEventLoopDelay`) while it ran; event streams are left out. Tests:
  `stallWatchdog.test.ts`.

- Docker - `Dockerfile` + `docker-compose.yml`; `docker compose up` runs the app container
  (port 4400) and a `postgres:16-alpine` db container for self-hosting.

## 10. Frontend Stack

- React 18.3.1 + Vite 8 - SPA, entry at `index.html`.
- Tailwind CSS 4.3.3 (`@tailwindcss/vite` 4.3.3) - styling; `tw-animate-css` 1.4.0 for animation
  utilities. Design tokens in `src/styles.css` (see `.context/DESIGN.md`).
- Tauri 2.9.0 (`@tauri-apps/cli`, `desktop/src-tauri`) - desktop app wrapper around the web build.
- Frame runtime (`src/frame-runtime/`): the script every frame iframe runs (morphing posted HTML in,
  hit testing, text editing, styles, the key relay, prototype triggers), written as TypeScript modules
  and type-checked and linted with the rest of `src/`. `vitePlugin.ts` (registered in `vite.config.ts`,
  so dev, `vite build`, vitest, the fixture build and Storybook all get it) bundles `main.ts` with
  esbuild into one strict IIFE served as `virtual:frame-runtime`, and `FRAME_BOOTSTRAP`
  (`src/lib/frameRuntime.ts`) inlines it in each frame's `srcdoc`: frames stay sandboxed
  (`allow-scripts`, no same origin), so the script is never loaded from Doop's origin. Every module
  only declares; `main.ts` sets everything up in one order, since listeners on one target run in the
  order they were added. `channel.ts` pins the intrinsics the key relay and the command check rely on
  when it is evaluated, before any design script runs; the runtime's own timers come from
  `timers.ts`. The dev server rebuilds the script when one of its sources changes. Tests:
  `frameRuntimeBuild.test.ts`, `frameRuntimeCss.test.ts` and the `*Browser.test.ts` files that drive
  frames.
- Chromium shell (the macOS app): `desktop/src-tauri-chromium` builds the same sources (its
  `[[bin]]` and build script point into `desktop/src-tauri`) on Tauri 3.0.0-alpha.5 with
  `tauri-runtime-cef` 3.0.0-alpha.6 (CEF 154, Chromium 154), so frame iframes render out of the
  editor's process. Same name, bundle id and executable as the WebKit app it replaces, so the
  WebKit app updates into it. Linking the CEF runtime makes `build.rs` set `cfg(chromium)`, which
  selects the runtime in `main()`, keeps the profile in `Application Support/design.doop.desktop/cef`
  (`cef-dev` for debug builds) and, on the first launch, moves the WebKit app's cookies and
  localStorage over (`src/webkit_migration.rs`, read in-process through WebKit's own API); menu
  types go through `ShellRuntime`. Run it with `bun run dev:chromium` or `build:chromium` in
  `desktop/` (Tauri 3 CLI, needs cmake + ninja); see `desktop/README.md`.
- Interface language (`src/lib/i18n/`, no library): English (`en/`, the source catalog, one
  `as const` namespace per area) and Brazilian Portuguese (`pt-BR/`, typed `Catalog`, so a missing
  key fails typecheck). Components call `useT()` and `t('namespace.key', vars)`; `{name}`
  placeholders are type-checked, `{ one, other }` values pick a plural by `{count}`, and a key kept
  in a table is a `PlainMessageKey` translated at render. The active language is this browser's pick
  (`doop-locale` in `localStorage`, Settings -> General), else the server's
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
  Workspace and Admin alike (a page's own group, such as the admin indexes, goes in as children;
  Settings draws its own rail from the same `ui/dash.tsx` parts); it owns
  the ⌘K search palette (`CanvasSearchModal.tsx`), the connect-an-agent modal, the collapsed
  narrow state (remembered in `localStorage` under `doop-rail`) and the account face at the bottom.
  From another page the rail sends scope picks home as `/?scope=` and new workspaces as
  `/?workspace=new`. The workspace in view opens under its row: All canvases, People, Fonts, Libraries, and for its owner and admins Plan & billing and Settings (`workspacePanesFor`); on the Workspace page
  they switch its pane in place, elsewhere they go to `/w/<id>?pane=…`, and the page keeps the
  pane in its URL. The rail keeps the last lists it drew (`lastLists`), so a page change does not
  blink its rows out, and fades only when collapsed or expanded. Home warms the Workspace page's
  detail while a workspace's canvases are in view (`src/lib/workspaceCache.ts`), so its panes draw on
  the first frame instead of a skeleton; the page refetches on arrival.

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
