# Plan: image descriptions

Spec: [../specs/image-descriptions.md](../specs/image-descriptions.md). Each task names its test
first; tests live in `tests/` and run with `bun run test`.

Status: all three phases shipped together in one PR (`feat/image-descriptions`). Deviations from
the tasks below: the preference lives in its own `image_description_prefs` table and
`/api/image-descriptions` rather than on the local-agent row; the model-tier tests are
`describerModels.test.ts`; the Settings card is covered by a component test
(`imageDescriptionsCard.test.tsx`) rather than a Chromium run; the 20s timeout is not unit-tested.

## Phase 1 — storage and the describer

1. **Schema.** `tests/imageDescriptions.test.ts`: a stored image asset reads back with
   `description null`, `describeAttempts 0`. Add `description`, `described_at`, `described_by`,
   `describe_attempts` to `assets` and `image_descriptions` to `local_agent_preferences` in
   `server/db/schema.ts`; `npx drizzle-kit generate` → `0044_image_descriptions.sql`.
2. **Event.** Same test file: `storeAsset` of a png with a `canvasId` emits `asset.stored` on
   `server/events.ts`; a woff, an svg and an asset without a canvas emit nothing. Add the event
   to the `CanvasEvent` union and the emit after the row insert in `server/assets.ts`.
3. **Describer resolution.** `tests/imageDescriber.test.ts`: (a) owner with a vision account →
   that provider, the small tier, low effort, `userId` the owner; (b) owner on an OpenRouter
   text-only pick → the server tier; (c) preference `off` → null; (d) preference `server` with an
   account connected → the server tier; (e) local Claude enabled → the server tier; (f) no key
   anywhere → null. Add `DESCRIBER_MODELS` to `shared/modelMenu.ts`, export a `smallTierFor`
   from `server/agentModel.ts` built on `byoModel` / `serverTiers`, and `describerFor(ownerId)`
   in `server/imageDescriptions.ts`.
4. **Worker.** Same test file, with the turn runner stubbed: (a) a queued asset ends with a
   description, `described_by` the label and the room receiving `asset:described`; (b) a thrown
   turn bumps `describe_attempts` and the third failure is the last; (c) the canvas day cap stops
   a 201st asset; (d) boot drains an undescribed row left in the table; (e) the image sent is at
   most 1500px on its long edge; (f) a 20s timeout aborts through `signal`. Implement the queue,
   `describeAsset`, the downscale (sharp is already a dependency of `server/screenshot.ts`; check
   before adding anything) and the prompt. Register the listener and the boot drain in
   `server/index.ts` next to `reconcileAssetRefs`.
5. **Env.** `DESCRIBE_PER_CANVAS_PER_DAY` and `DESCRIBE_CONCURRENCY` in `server/env.ts` and
   `.env.example`.

## Phase 2 — agents read it

6. **MCP.** `tests/mcp-tools.test.ts`, a new describe block: `get_canvas` lists `images` per frame
   from `asset_refs` with the description, `null` while pending, and carries the note only when
   some frame has an image; `get_frame` carries the same field. Add `imagesForFrames(frameIds)` to
   `server/assets.ts` (one query, grouped), extend `frameSummary` with an optional `images` and
   the note in `get_canvas`.
7. **Resident kickoff.** `tests/residentKickoff.test.ts` (or the nearest existing resident test):
   the frame list carries an `image:` line under a frame with a described asset, labels a
   standalone image frame `(pasted image)`, and ends with the look-before-you-design sentence.
   Extend the `frameList` builder in `server/resident.ts`.
8. **Guide.** One paragraph in `server/guide.ts` under "Frames and HTML": what `images` is and
   when to screenshot. Covered by the existing guide snapshot test if there is one; otherwise a
   substring assertion in the MCP test.
9. **Parity.** `tests/agentToolParity.test.ts` stays green: no new tools, only fields.

## Phase 3 — the setting

10. **API.** `tests/agentPreferencesHttp.test.ts`: `GET /api/agent-preferences` returns
    `imageDescriptions` and `describer { label | null, reason }`; `PUT` with each of the three
    values persists, an unknown value is 400. Rename `local_agent_preferences` →
    `agent_preferences` in the same migration as task 1 if the rename is cheap; otherwise keep
    the table name and only widen the row. Add `shared/agentPreferences.ts`.
11. **Settings → Agents.** `tests/settingsAgentsBrowser.test.ts` (Chromium, the pattern of
    `authFormBrowser.test.ts`): the card shows the three-way `Segmented`, a pick calls `PUT`, the
    status label shows the resolver's label or its reason. Build the `SettingsCard` in
    `src/pages/Settings.tsx` under the `agent` pane; strings in `src/lib/i18n/en/settings.ts` and
    `pt-BR` (`tests/i18n.test.ts` guards the catalog).
12. **Docs.** A bullet in `.context/TECHSTACK.md` §2 for the describer, with the test names; the
    spec moves from "planned" wording to present tense where it says "will".

## Out of scope for this plan

- Backfilling existing assets (a `scripts/` command later).
- Showing descriptions to humans in the editor.
- No-model frame summaries.
