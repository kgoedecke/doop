# ChatGPT app

Doop as a first-party app inside ChatGPT: the existing MCP server (`/mcp`) made to pass
ChatGPT's app review, plus an inline preview card so people see the design in the conversation,
plus the marketing page that targets "Claude Design for ChatGPT" and "design canvas for ChatGPT".
No second server, no OpenAPI "GPT Action": ChatGPT apps are MCP servers over OAuth, which is
what `/mcp` already is.

## What ChatGPT needs from the server

Source: developers.openai.com/apps-sdk (build/auth, build/mcp-server, app-submission-guidelines),
read 2026-10-14.

| Requirement                                                                                                                     | Where it is met                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Streamable HTTP endpoint on public HTTPS                                                                                        | `app.all('/mcp')` in `server/index.ts`                                                                                         |
| 401 + `WWW-Authenticate: Bearer resource_metadata=…` for missing/stale tokens                                                   | `handleMcpRequest` in `server/mcp.ts`                                                                                          |
| Protected-resource metadata whose `authorization_servers` equals the issuer                                                     | `/.well-known/oauth-protected-resource[/mcp]`, `authorization_servers: [BETTER_AUTH_URL]`                                      |
| AS metadata with `code_challenge_methods_supported: ["S256"]`, `registration_endpoint`, `token_endpoint_auth_methods_supported` | better-auth's `mcp` plugin, bridged at `/.well-known/oauth-authorization-server` and (new) `/.well-known/openid-configuration` |
| Client registration: CIMD preferred, DCR accepted                                                                               | DCR via better-auth `/api/auth/mcp/register`. CIMD is not supported by better-auth 1.6; ChatGPT falls back to DCR              |
| Explicit `readOnlyHint` / `destructiveHint` / `openWorldHint` on every tool                                                     | every `registerTool` in `server/mcp.ts` (+ extensions), enforced by `tests/mcp-tools.test.ts`                                  |
| A human-readable `title` per tool                                                                                               | same                                                                                                                           |
| Optional `openai/profile` tool for multi-account                                                                                | `get_profile`                                                                                                                  |

Not done, by choice: RFC 9207 `iss` in authorization responses (better-auth does not emit it; the
metadata does not advertise it, so ChatGPT does not require it) and mTLS pinning of ChatGPT's
egress certificate (optional hardening).

### Lessons taken from SlideSpeak's ChatGPT app (`slidespeak-monorepo/backend/chatgpt-app`)

SlideSpeak shipped an Apps SDK connector against a live ChatGPT and recorded what it took. The
parts that apply to Doop are in `handleMcpRequest`:

- **The challenge goes in the body too.** ChatGPT offers "Connect" only when the
  `WWW-Authenticate` value is also in the 401 body as `_meta["mcp/www_authenticate"]`. The header
  carries `scope=` and, when a bearer was presented but did not validate, `error="invalid_token"`
  (RFC 6750 §3.1: no `error` when no token was sent).
- **Old cards re-fetch their template without a token.** Reopening a chat, or a token rotation,
  makes ChatGPT call `resources/read` for the component with no usable bearer; a 401 there
  strands every card ever rendered ("Failed to fetch template"). `ping`, `resources/list` and
  `resources/read` (single messages only, never a batch) therefore answer anonymously. The
  template is static and the resource list carries no user data. SlideSpeak also opened
  `initialize` and `tools/list`; Doop keeps those gated so the proven Claude Code / Cursor / Codex
  connect flow (401 on the first call starts OAuth) is untouched. If testing in ChatGPT shows
  old cards failing to fetch their template, add `initialize` and `notifications/initialized` to
  `ANONYMOUS_METHODS`.
- **JSON responses, Accept normalised.** The SDK transport answers 406 to any `Accept` narrower
  than `application/json, text/event-stream`, and ChatGPT's template-fetch path sends a narrower
  one. `/mcp` now normalises the header and answers with a JSON body instead of an SSE stream
  (`enableJsonResponse: true`): no Doop tool sends notifications mid-call, so a stream carried
  nothing a JSON body does not, and JSON is what every client can read.
- **The component URI is a cache key.** `ui://doop/frame-preview-<n>.html`: any change to the
  markup bumps `PREVIEW_VERSION` and appends the old URI to `RETIRED_PREVIEW_URIS`, which stay
  served forever, because a chat holding a retired URI cannot render its card.
- **Domain verification.** The hosted doop.design deployment serves
  `/.well-known/openai-apps-challenge` with OpenAI's bare challenge token; this repo answers 404
  there, since only the directory listing's owner needs it.
- **Stateless on purpose.** ChatGPT relays component-initiated calls as independent requests, so
  a session-keyed server would answer "Server not initialized". `/mcp` was already stateless.
- Not copied: per-tool `securitySchemes` (SlideSpeak grafts them onto the `tools/list` response
  because the SDK drops the field). Every Doop tool needs the same OAuth session, which the
  connection-level 401 already establishes; add them if some tools ever become anonymous.

### Annotation policy

- `readOnlyHint: true` only for tools that change nothing about the design: reads, searches,
  screenshots, export URLs. Reads that take `agent_name` (`get_canvas`, `get_frame_screenshot`,
  `get_guidelines`, `list_guidelines`) also deliver, and thereby claim, the human feedback
  addressed to that agent. That is bookkeeping about the caller's own inbox, not a change to
  the canvas, so they stay read-only: the hint decides whether the host asks the person before
  running a tool, and asking before every read would make the app unusable. `get_feedback`
  exists to claim work, so it is the one feedback-claiming write.
- `destructiveHint: true` for deletion and whole-content overwrites: `delete_frame`,
  `set_canvas_pages` (can delete pages), `set_frame_html` and `set_guidelines` (replace). The
  streaming path (`append_frame_html`, `start: true`) and `edit_frame_html` stay non-destructive:
  they are how designs are made and ChatGPT would otherwise ask to confirm every section.
- `openWorldHint: true` for anything reaching the public internet: website viewing/importing,
  stock photos, icons, logos, inspiration, `upload_asset` and `import_psd` (fetch a URL).
  `list_backgrounds` and `generate_image` are bounded services, so `false`.

## The preview card (`server/chatgptApp.ts`)

ChatGPT renders an HTML component next to a tool result when the tool's `_meta` names a
resource. Doop registers one component, `ui://doop/frame-preview-2.html` (the URI doubles as
the version: bump `PREVIEW_VERSION` and append the old URI to `RETIRED_PREVIEW_URIS` whenever
the markup changes, because hosts cache the template per URI; version 1 is retired but still
served for chats that hold it), served as
`text/html;profile=mcp-app` (the MCP Apps standard, which ChatGPT now speaks) with ChatGPT's
original `openai/*` aliases set as well:

- Tools that carry it: `get_canvas`, `set_frame_html`, `edit_frame_html`, `update_frame`,
  `get_frame_screenshot`, `import_webpage`, `import_psd`. Each adds `structuredContent:
CanvasPreview` (`{ canvas: {id,name,url}, frames: [{id,name,width,height,image_url,url,empty}]
}`) via `withPreview()`. `append_frame_html` deliberately has no card: one card per streamed
  chunk would flood the chat; the review screenshot after the stream shows the result. Neither
  does `create_frame`: in the streaming flow the frame is empty at that point, and a card showing
  a blank artboard never updates (seen in the first real ChatGPT test, 2026-10-16). A frame whose
  HTML is still empty (`empty: true`, e.g. listed by `get_canvas` mid-stream) shows a "Design in
  progress" placeholder instead of a render.
- The component is dependency-free HTML: a grid of `/i/<frame>.png?scale=1&v=<updatedAt>` renders
  (public route, cache-busted per edit) and an "Open in Doop" button. It speaks both host
  dialects: the MCP Apps handshake (`ui/initialize` with `protocolVersion: "2026-01-26"`, then
  `ui/notifications/initialized`, then `ui/notifications/tool-result`, `ui/open-link` for links,
  `ui/notifications/size-changed` after each render, `ping` answered; a JSON-RPC `error` reply
  rejects the request, so a refused handshake leaves the bridge unconnected and links fall back
  to `window.open`) and ChatGPT's original `window.openai` globals (`toolOutput`,
  `openai:set_globals`, `openExternal`). The handshake messages were taken from
  `@modelcontextprotocol/ext-apps` 2.0.3 rather than bundling it, so there is no build step.
  Colours come from the host's `--color-*` tokens with Doop fallbacks.
- Image loads are metered: the card runs in a sandbox iframe that sends no Doop cookies, so each
  uncached render counts against the anonymous per-IP budget (`PREVIEW_RENDERS_PER_MIN`, 12).
  Three things keep it inside that budget: `get_frame_screenshot` primes the image cache with
  the render it already made (`primeImage` in `server/previews.ts`, keyed per frame version), so
  the usual edit → screenshot → card sequence loads from cache; the card shows at most six frames
  and a "+N more" tile that opens the canvas; a failed load keeps its slot with a Retry button
  instead of vanishing.
- Verified so far only in headless Chrome with mocked `window.openai`; the first real check is
  the Developer-mode test in the submission checklist below.
- CSP: `resource_domains` / `resourceDomains` and `redirect_domains` are the server origin
  (`BETTER_AUTH_URL`), so self-hosted instances work unchanged. No `connect_domains`: the card
  makes no fetches.

The model's view is unchanged: `content` is exactly what it was, so Claude, Cursor and Codex
see no difference.

## Marketing

- `doop-marketing` (separate repo): `/claude-design-for-chatgpt` pillar page (FAQ JSON-LD,
  comparison table, connect steps), a ChatGPT section in `/docs/get-started#chatgpt`, docs nav
  and sitemap entries. The product server's proxy allowlist (`server/marketing.ts`) passes the
  new path through.
- The in-app Connect modal's ChatGPT entry (`src/components/ConnectModal.tsx`) already documents
  the Developer-mode connector path; once the directory listing is live its first step should
  become "find Doop in the app directory".

## The plugin package (`chatgpt-plugin/`)

ChatGPT directory submissions are a ZIP ("plugin package"): `plugin.json` (Agent Plugins manifest
with the listing, review test cases and release notes under `extensions.com.openai`), `mcp.json`
(the one remote server, `https://doop.design/mcp`, OAuth with dynamic client registration) and
`assets/logo.png`. `node scripts/build-chatgpt-plugin.mjs` checks the dashboard's field limits
(30-char name and subtitle, 4000-char description, 3 prompts of 128, five positive and three
negative test cases) and writes `chatgpt-plugin/dist/doop.zip`. Reviewer credentials never go in
the package; the dashboard rejects them.

## Submitting to the ChatGPT app directory (manual, needs the OpenAI account owner)

1. Verify the organisation in the OpenAI Platform dashboard (general settings).
2. Create the app with the MCP server URL `https://doop.design/mcp`, auth = OAuth. ChatGPT
   registers itself through DCR; no client id to paste.
3. Metadata: name **Doop** (no "MCP"/"plugin" suffix), subtitle under 30 characters, e.g.
   "Design canvas for ChatGPT", description of functionality only (no pricing, no comparisons),
   example prompts instead of screenshots, logo from `doop-marketing/public/logo.png`.
4. Privacy policy `https://doop.design/privacy`, terms `https://doop.design/terms`, support
   `hello@doop.design`. Review the privacy page against the checklist: data categories, purposes,
   recipients, retention, user controls.
5. Test account: a fully featured demo account with sample canvases, password sign-in, no 2FA.
6. Test in Developer mode first (Settings → Connectors → Advanced): connect, run a brief, check
   that the preview card renders, that "Open in Doop" opens the canvas, and that a revoked token
   re-triggers the sign-in.
7. Submit. Annotation justifications are no longer required; appeal if automated review flags one.

Example prompts for the listing:

- "Design a landing page hero for a coffee subscription. Dark, editorial, one bold display face."
- "Redesign the pricing section of acme.com on my Doop canvas."
- "Turn these three bullet points into a pitch slide."
- "Make the call-to-action on my hero frame bigger and red."
