# Image descriptions

Why: an agent arriving on a canvas sees each frame as a name, a size and a byte count
(`frameSummary` in `server/mcp.ts`, the frame list in the resident kickoff). A pasted screenshot
is a 600-byte frame called "Screenshot 2026-11-03 at 10.12.41" holding one `<img>` whose only
text is the filename, and nothing tells the agent to look at it. Users report agents that are
"not aware of what is on the canvas". This spec gives every uploaded image a stored, model-written
description once, and puts it in front of every agent that reads the canvas, so a text-only model
knows what the picture is and a vision model knows which frames are worth a screenshot.

## Describing (`server/imageDescriptions.ts`)

- **Trigger**: `storeAsset` (`server/assets.ts`) emits `asset.stored` on the canvas event bus
  (`server/events.ts`) for image mimes (png, jpg, webp, gif) with a `canvasId`. Fonts, avatars and
  svg are not described. Every entry point passes through it: browser paste and drop, MCP
  `upload_asset`, PDF import, `generate_image`.
- **Queue**: in-memory, drained by one worker loop (the pattern of the reveal loop in
  `server/actions.ts`), at most `DESCRIBE_CONCURRENCY` (2) calls in flight. At boot the worker
  also picks up rows with `described_at IS NULL AND describe_attempts < 3` so a restart loses
  nothing. The upload request never waits.
- **One call per asset**, ever: assets are immutable. The image is downscaled to a 1500px long
  edge JPEG first (the `frameImageBlocks` approach in `server/resident.ts`), and the prompt asks
  for a description a designer who cannot see the image could work from: kind (app screenshot,
  photo, logo, chart, sketch), visible UI and content, headings and copy, palette, layout, under
  120 words. One `AgentTurnRequest` with no tools, `maxTokens` 400.
- **Result** lands on the asset row: `description`, `described_at`, `described_by` (the model
  label), `describe_attempts`. A failed call bumps `describe_attempts` and comes back through the queue
  after `DESCRIBE_RETRY_MS` (30s); after three it is left alone. A 20s timeout bounds the whole
  turn, a ChatGPT token refresh included, so a stalled provider never holds a worker slot.
- **Caps**: `DESCRIBE_PER_CANVAS_PER_DAY` (200, env-overridable; a failed call counts, since it
  may have cost something) and `DESCRIBE_CONCURRENCY` (2). Over the cap, the asset stays
  undescribed and a log line says so.
- **Broadcast**: a finished description is sent to the room as `asset:described { assetId,
description }` so an agent already in a run can be told (future) and the browser can show it as
  the image layer's tooltip (not in scope here).

## Which model, whose bill (`describerFor(canvas)`)

Resolved per asset from the canvas owner's preference and account, in this order:

1. Owner's preference `imageDescriptions` is `off`: nothing runs.
2. `account` (the default): the owner's connected model account (`getAccount`) when it exists and
   `accountVisionFor` is true. Routed through the account's provider (`byoModel`), but with that
   provider's small tier (`DESCRIBER_MODELS` in `shared/modelMenu.ts`: Haiku 4.5, the mini tier on
   OpenAI and ChatGPT, flash on Gemini, a fixed OpenRouter pick) and low effort, never the model
   or effort the owner picked for design work. ChatGPT accounts go through `withFreshToken` first.
   Local Claude and the Gemini cloud pilot are harness-only and are skipped.
3. Otherwise the server tier (`serverTiers`, `ANTHROPIC_API_KEY` or Azure) on the small model.
   Not counted against the free-task allowance. With no server key the asset stays undescribed.
4. `server` preference: step 3 only, for an owner who does not want pastes on their subscription.

The owner pays, not the uploader: it is their canvas, and it is the one rule automations and
resident runs already use. Settings says so next to the switch.

## Preference (`server/agentPreferences.ts`, column on `local_agent_preferences` → renamed

`agent_preferences`)

`image_descriptions text not null default 'account'` (`off` | `account` | `server`), per user,
read and written by `GET`/`PUT /api/agent-preferences` alongside the local-agent fields that table
already holds. Shared shape and the three values in `shared/agentPreferences.ts`.

Settings → Agents gets a `SettingsCard` "Image descriptions" (`ImageDescriptionsCard.tsx`): a
`Segmented` with the three options and a `StatusLabel` saying which model would run right now
(`describer` from the GET), so a text-only account or an instance without a server key explains
itself.

## What agents receive

- `get_canvas`: each frame summary gains `images: [{ src, description }]` for the assets
  `asset_refs` links to it (undescribed ones carry `description: null`). The note gains: "Frames
  whose `images` carry descriptions are pictures people put on the canvas, often reference
  screenshots: read the descriptions, and screenshot the relevant ones before designing."
- `get_frame`: the same `images` field beside the HTML.
- Resident kickoff (`server/resident.ts`): under each frame line, one indented line per image
  `image: <description>` (first 300 chars), and the same sentence as above once at the end of the
  list. A frame that is only a standalone image (`data-doop-canvas-element` body with one image
  layer) is labelled `(pasted image)`.
- `get_frame_screenshot` and `screenshot_frame` are unchanged: a vision model still sees the
  pixels.

Descriptions are never written into frame HTML. The `alt` the paste wrote stays the filename, so
no user document changes, no version is cut and no activity line appears.

## Non-goals

- Model-written frame summaries: frames change on every save; a later spec, if at all, for
  signed-off frames. A no-model text summary (headings, visible copy, layer names) is tracked
  separately.
- Describing images already on the canvas before this ships: migration 0044 marks them out of
  attempts, so the first boot never bills every owner for their history; a one-off backfill
  command resetting `describe_attempts` may follow.
- Showing the description to humans in the editor (Inspector, Layers tooltip): follows once the
  data exists.
- Re-describing an image when a frame crops or recolours it: the description is of the asset.
