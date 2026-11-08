# Image descriptions

An agent arriving on a canvas sees frame names, sizes and byte counts. A pasted screenshot
needs a description so the agent knows what it shows and when to inspect the pixels.

## Describing (`server/imageDescriptions.ts`)

- `storeAsset` emits `asset.stored` for PNG, JPEG, WebP and GIF assets with a canvas.
  Browser paste/drop, MCP uploads and generated images share this pipeline. SVG, fonts and
  assets without a canvas are excluded. The upload never waits for analysis.
- An in-memory FIFO runs at most `DESCRIBE_CONCURRENCY` (default 2) jobs at a time. The asset
  row is the recovery record: startup requeues undescribed rows with fewer than three failed
  attempts. There is no distributed claim or exactly-once guarantee across processes.
- Images are resized to a maximum 1500px long edge and flattened to JPEG. A single model turn
  with no tools asks for under 120 words describing the content, layout, copy and palette.
  The request asks for 400 output tokens; the ChatGPT transport does not support that cap.
- A 20s deadline bounds model selection, asset loading, resizing and the model request,
  including token refresh. The signal reaches disk/S3 reads and the model transport. A late
  storage result cannot start a model request after the deadline. Failures during asset loading
  or model work increment `describe_attempts` and retry after `DESCRIBE_RETRY_MS` (default 30s),
  up to three failed attempts. A deleted canvas is skipped, including after a pending read.
- `DESCRIBE_PER_CANVAS_PER_DAY` defaults to 200 attempts per canvas per UTC day. It is an
  in-memory counter, reset on restart; failed storage/model work counts. An over-budget image
  stays undescribed. No-model, disabled and budget-skipped images are not automatically
  requeued by a settings change or the next day; startup can reconsider them.
- Success stores `description`, `described_at` and `described_by` on the asset and broadcasts
  `asset:described`. Migration 0049 marks older assets out of attempts to avoid a historical
  backfill. It also adds the durable payer/provider selection for retries.

## Which account pays

`assets.owner_id` records the authenticated uploader's stable user ID at upload time. It is
not the canvas owner; `uploaded_by` is only a display name. Automated uploads without an
identified uploader start with the canvas owner's account. Never infer a payer from a name.

For a live canvas, resolve `image_description_prefs` for the uploader and canvas owner:

1. If either person's mode is `off`, stop analysis entirely.
2. A `server` uploader explicitly uses server credentials only, bypassing both user accounts.
3. Otherwise try the uploader's enabled, vision-capable accounts first: their default
   connection first, then the remaining accounts in connection order. Disabled connections
   and local-only harnesses are excluded.
4. If unavailable, try the canvas owner's account only when the owner's mode is `account`.
   The default `account` mode permits this owner fallback; `server` excludes their account.
5. Finally try the configured server tier. If none is available, leave the image undescribed.

Account lookup errors are failures, not permission to charge someone else. Missing accounts
or an ineligible vision model allow fallback; runtime errors, exhausted credits and timeouts
do not. Before storage/model work, save `describe_payer_id` and `describe_provider`; a null
payer with a selected provider means server billing. Subsequent attempts, including restart
recovery, reload only that payer/provider. Connecting a new account or changing server provider
does not move an existing job to it. Disconnecting the selected account or withdrawing consent
stops the job without choosing another payer. Fresh credentials are still read on each attempt.

`accountDescriber` uses Haiku for Anthropic, Flash for Gemini and OpenRouter, and the selected
ChatGPT/OpenAI model at low effort. A text-only OpenRouter design model is replaced by the
vision-capable Flash tier for this job. Local Claude and the Gemini pilot are not describers.
The server uses Haiku on its Anthropic key or its configured Azure deployment. Descriptions
do not consume the free-task allowance.

## Settings

`GET`/`PUT /api/image-descriptions` reads and writes the per-user `image_description_prefs`
mode (`off`, `account`, `server`), defaulting to `account`. Settings → Agents explains upload
billing, owner fallback and the scope of Off. Its status previews an available model for the
user without a specific canvas; another canvas owner's eligible account may precede the server.

## What agents receive

- `get_canvas` and `get_frame` include `images: [{ src, description }]` from `asset_refs`.
  Descriptions are null while pending, disabled, unavailable or exhausted.
- Resident kickoff quotes the first 300 characters under each frame. Only a canvas-element
  body containing one image layer, no other content, and one referenced raster asset is marked
  `(pasted image)`. A detached card containing an image remains an editable design.
- Agents are told to inspect relevant screenshots. The broadcast does not yet update an
  already-running agent's context or show a description tooltip in the editor.

Descriptions never modify frame HTML, alt text, versions or activity. Historical backfilling,
frame summaries, human-facing descriptions and re-describing crops/recolours are out of scope.

## Validation

Routing and queue regressions are covered by `imageDescriptions.test.ts`; migration coverage in
`imageDescriptionsMigration.test.ts` verifies that old assets cannot trigger billing while new
uploads start eligible. MCP, settings and provider tests cover the model labels and agent context.
