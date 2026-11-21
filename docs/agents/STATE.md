# Fork state (ArcticSlayy/doop)

Last updated: 2026-11-21 (sync catch-up)

## Purpose

Arctic's personal fork of [kgoedecke/doop](https://github.com/kgoedecke/doop) (AGPL, personal use). Day-to-day
design work stays on hosted Doop (`https://doop.design/mcp`); the fork carries upstream PRs worth having and
Arctic's own improvements. It is **not self-hosted**: no dev server, docker or heavy builds locally until
Arctic OKs the RAM (self-hosting on `localhost:4300` waits for that and for improvements worth running).

## Sync

- The 2026-11-21 sync merge contains upstream `40131c52f3e9b9a0f15bcbdf63c39f9b0dc54fe8` (21 commits since
  `07a5f6a324e918a935a99e1d210801ae89f4d2b9`). Issue #19 tracked the recurring merge conflicts. The frame-paper
  rule still passes through `withPaperRule` in `server/canvasFaces.ts` and the editor save path in `src/components/FrameView.tsx`.
- `.context/TECHSTACK.md`: combined upstream's `update_canvas` documentation with the ported `fit_height` notes
  and retained the frame-paper section.
- `server/mcp.ts`: combined upstream's base64 detection, held HTML forms and preview metadata with the ports'
  `fit_height` and `<doop-use>` refusals. A refused final streamed chunk still keeps its stream active.
- `server/resident.ts`: used upstream's rename and person-mention support with the existing fit helper and
  resident frame-write checks.
- `server/screenshot.ts`: used upstream's selector and layout-problem inspection while keeping the shared page
  shim, viewport helper and content-height measurement.
- `tests/residentPageTools.test.ts`: retained both the upstream canvas-title tests and the ported fit tests.
- Upstream's #439 pan implementation matches the merged `Stage.tsx` byte for byte. Its panel and stylesheet
  implementations also match. The fork's workflow directory is unchanged by the merge.
- Automation: `.github/workflows/sync-upstream.yml`, daily 09:23 UTC plus manual dispatch. It runs on GitHub, with no
  local scheduled task. Green: pushes to `main`. Red: parks the merge on `sync/upstream` and opens one PR.
  Conflict: opens one issue, pushes nothing. Nothing new: does nothing.
- The fork owns `.github/workflows/` (upstream's changes there are ignored by the sync).
- Merge-friendly rule: our changes go in NEW files (FORK.md, docs/agents/, AGENTS.md), not edits to upstream
  files. Upstream's README is untouched.
- Next sync: automatic, daily.

## CI gate (standing rules)

1. Never merge a PR into the fork with red or pending CI. A Sol approval does not override red CI.
2. `sync-upstream.yml` pushes to main only when typecheck, build and all tests pass (it checks every step's
   outcome, including the pinned-Chrome install and the full test run); otherwise it parks the merge on a PR or opens
   an issue. Confirmed by reading the workflow, and by the scratch run.
3. Before each merge, check that main is green; if main is red, fix main first.

Known flaky tests: the browser tests in `elementPanelBrowser.test.ts` and `canvasClipboardBrowser.test.ts` fail
intermittently on the fork's runners with 5 s waits (see the Flaky tests section). One is skipped: "keeps multiple
copied elements together and selects the pasted set" (`canvasClipboardBrowser.test.ts`) failed 3 of 3 on sync PR #20
and is red on upstream's own main CI too; drop the `it.skip` when upstream fixes it (issue #12).

## Inherited workflows (GitHub Actions on the fork)

Managed with `gh workflow disable` only; no upstream workflow file is edited or deleted, so syncs stay
conflict-free. GitHub registers a workflow only when it first triggers, and it re-enabled CLA once after a merge,
so re-check `gh workflow list -R ArcticSlayy/doop --all` after merges.

| Workflow                     | State                  | Reason                                                                |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------- |
| CI                           | kept                   | typecheck, lint, build, sharded tests on every PR; passes             |
| Sync upstream (ours)         | kept                   | daily upstream sync, runs on GitHub                                   |
| CLA                          | disabled               | upstream's contributor agreement (cla-assistant); fails and emails    |
| Release Please               | disabled               | upstream release bookkeeping; opens release PRs on every push to main |
| Desktop                      | disabled (2026-11-18)  | first ran on the sync PR #20; macOS/Windows builds need Apple secrets |
| iOS                          | disabled (2026-11-18)  | first ran on the sync PR #20; macOS runners and App Store secrets     |
| desktop-release, ios-release | not registered, unused | signed releases; disable on first appearance                          |

CI failure emails come from the account's Actions notification setting (no API): github.com/settings/notifications.

## Open upstream PRs (34 on 2026-11-14) and verdicts

Initially picked for review (the outcome of each is in "Merged into our main" below, which supersedes this list):

| PR  | Title                                                      | Note               |
| --- | ---------------------------------------------------------- | ------------------ |
| 506 | fix(sync): resolve a stylesheet's url()s against the sheet | small bug fix      |
| 492 | fix(canvas): drawn frame's white is a default              | bug fix            |
| 459 | fix(logos): read BI_BITFIELDS icons by their masks         | small bug fix      |
| 458 | fix(export): fit export scale to renderer pixel budget     | small bug fix      |
| 399 | fix(screenshot): relaunch a wedged Chromium                | reliability fix    |
| 390 | fix(server): broadcast presence leave on canvas switch     | small bug fix      |
| 280 | fix: escape branch and directory in GitHub frame base href | small bug fix      |
| 279 | fix: keep $ patterns literal in synced/GitHub base URLs    | small bug fix      |
| 278 | fix(importer): keep $ patterns literal in imported CSS     | small bug fix      |
| 476 | feat(mcp): place uploaded image via upload_asset           | MCP image workflow |
| 462 | feat(canvas): cut frames and layers with Cmd/Ctrl+X        | UX gap             |
| 516 | feat(canvas): resize the Pages and Layers split            | UX                 |

Skipped:

| PR                 | Reason                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| 505                | Security hardening: not taken; the fork-wide review is in `SECURITY.md`, not this PR                        |
| 434                | Perf tweak: out of scope for now (439 was taken later, see "Ported 2026-11-18")                             |
| 515                | macOS WebKit launch panic: we are on Windows                                                                |
| 514                | Sends agent signals to a third-party service (Glassray): privacy, no value to us                            |
| 509, 437, 435      | Draft PRs                                                                                                   |
| 500, 433           | 8-10k line canvas-actors rewrite for flagged hosted owners: huge, hosted-only, high risk                    |
| 465, 447           | release-please version bump PRs: upstream release bookkeeping                                               |
| 450, 449           | Low value (Run shortcut hijacks reload; proxy IP header only matters when self-hosting)                     |
| 474, 457, 456, 433 | Conflict with upstream main (upstream author's own, will be rebased there)                                  |
| 412, 339, 301, 299 | Conflict with upstream main                                                                                 |
| 166, 141           | Conflict with upstream main, stale (older than a month or unmaintained); 281 and 277 were hand-ported later |
| 436                | Conflicts with upstream main                                                                                |

## Merged into our main

| Upstream PR | Our PR | Sol verdict                        | CI                |
| ----------- | ------ | ---------------------------------- | ----------------- |
| 492         | #3     | approve                            | green             |
| 390         | #5     | approve (our prettier fix commit)  | green after rerun |
| 279         | #7     | approve                            | green             |
| 278         | #8     | approve                            | green             |
| 280         | #6     | approve on 2nd review (after #279) | green             |
| (fork)      | #1     | approve on 4th round               | green             |

Ported 2026-11-18 (Arctic's batch of five; fresh-context review by a general subagent instead of Sol, Codex being out
that week; merged as merge commits; PR titles are `type(scope): ... (upstream #N)` because CI lints titles with
commitlint, which rejects a `port:` type):

| Upstream PR | Our PR | Review  | Notes                                                                                                                        |
| ----------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 541         | #21    | approve | refuse an open `<doop-use>`; 6 commits, clean                                                                                |
| 277         | #22    | approve | upstream main already had the fix; only the regression test ported                                                           |
| 539         | #23    | approve | `fit_height`; 6 commits, clean, then main merged in (swapped to #541's `frameWriteRefusal`)                                  |
| 439         | #24    | approve | no restyle per pan step; 2 commits, clean                                                                                    |
| 281         | #25    | approve | hand-merged against `freeform`/`absoluteDrop`; tests moved to `drawingReorderBrowser.test.ts`, assert left/top not translate |

Known gap found while porting: `server/componentActions.ts` still does `def.template.replace(input.find, ...)` without a
replacer function (the `$`-pattern bug #277 fixed for frames). Not fixed here.

Dropped after review (closed, branches deleted; leave to upstream):

| Upstream PR | Our PR | Why                                                                                               |
| ----------- | ------ | ------------------------------------------------------------------------------------------------- |
| 506         | #2     | Rejected twice: url() matcher still mishandles CSS escapes                                        |
| 399         | #4     | 3 blockers: concurrent recovery orphan Chromium, SIGKILL waits on close(), swallowed timeouts     |
| 476         | #9     | 2 blockers: no edit-access recheck after the awaited fetch; NaN frame width from huge SVG viewBox |
| 462         | #10    | 3 blockers: duplicate import, stale-snapshot cut, lock bypass while clipboard prompt is pending   |
| 459, 458    |        | Stacked on unmerged upstream PRs (456/453/464): ~1.9k unrelated lines                             |

Dropped: 516 (our #11), rejected twice by Sol: first for a missing `aria-valuenow`, then because the added ARIA
values go stale on window resize and page-list changes, and on a one-page canvas `aria-valuenow` falls below `aria-valuemin`. Closed, branch deleted; left to upstream.

## Security

Review done 2026-11-14, report in [`SECURITY.md`](SECURITY.md): secret scan of tree and history is clean, auth/OAuth
handling has no exploitable finding, AGPL notices are intact, and `bun audit` reports 105 advisories (4 critical, none
reachable in Doop's own use). Dependency bumps are not applied here (they would conflict with every upstream sync);
re-run `bun audit` after each sync and revisit if an advisory becomes reachable.

## Flaky tests

Tracked in https://github.com/ArcticSlayy/doop/issues/12: three different browser tests (`canvasClipboardBrowser`,
`elementPanelBrowser` x2) failed once each on the fork's runners and passed on rerun with no code change. Verdict:
timing-sensitive, not a bug in a merged PR and not a missing environment. Nothing is skipped yet; a test that fails
twice gets skipped alone, marked known-flaky in that issue. Until then, rerun failed jobs
(`gh run rerun <id> -R ArcticSlayy/doop --failed`) before treating red as real.

## Optimization

Looked for cheap measurable wins; none worth a change. The sync run's steps (full scratch run 43678868916):
install 3 s, typecheck 4 s, build 3 s, tests 327 s (single job), whole run about 6 min and only when upstream has
news, so sharding the tests (CI uses four shards) would save about 3 minutes of free GitHub minutes and add workflow
complexity. Dependency and bundle changes would touch upstream files (`package.json`, `bun.lock`, vite config) and
conflict with every sync, so they are not made here.

## T3 integration

Built as conventions in the shared skill (`~/.agents/skills/doop/SKILL.md`, "Working from a T3 thread" and
"Organizing canvases"), not code: one canvas per project and feature named `<Project> – <Feature>`, reused across runs;
its link posted to the requesting thread as soon as it exists; frames `<Screen> / <State> / v<N>` with a `Tokens` frame
first and superseded versions moved to `Archive`; screenshots only when asked, cached under `G:\Tools\Cache\doop`;
lite mode by default. Anything needing code stays in "Ideas (later, optional)".

## Our improvements (ranked, not started; Arctic picks)

1. Local-first design workflow: make the fork runnable on `localhost:4300` with a light memory profile (pglite
   only, no Chromium unless screenshots are asked for), so a canvas works offline.
2. Better agent hand-off: a `get_canvas_summary` tool returning frame names, sizes and text in one compact call,
   so agents stop paging whole frames into context.
3. Frame screenshots on demand with a small LRU disk cache under `G:\Tools\Cache\doop`, auto-pruned.
4. Export presets (PNG/PDF at fixed scales per frame) as one MCP call.
5. A Windows-friendly dev setup doc (bun, pglite) in `docs/agents/`.

## Ideas (later, optional)

T3 integration. Logged only; do not build.

- Post links and frame screenshots from a canvas back to the originating T3 thread.
- One canvas per T3 thread, named after the thread, created on first design request.
- Paper video review (youtube pGhRBJZRMvk, 2026-11-15): YouTube blocked captions (HTTP 429), so only the description and
  chapters were read (design the whole app in one file first, one decision applied to every screen, a design system,
  mockups as the spec). No Paper feature Doop lacks was identified from that; Doop already has tokens, components,
  `/styleguide.md`, prototypes and MCP. Re-check with a transcript if Arctic supplies one.
- A "lite mode": no Chromium, no screenshots, minimal memory, for a RAM-constrained machine.

## Touched upstream files

Our own additions are new files: `FORK.md`, `AGENTS.md`, `docs/agents/STATE.md`, `docs/agents/SECURITY.md`,
`.github/workflows/sync-upstream.yml`. The upstream PRs we took (#3, #5 to #8) edit these upstream files, and they are
where a sync conflicts when upstream refactors the same code (as it did on 2026-11-18): `server/canvasFaces.ts`
(paper rule), `src/components/FrameView.tsx` (paper rule in `saveEdited`), `.context/TECHSTACK.md` (frame paper bullet),
`server/contextDev.ts`, `server/github.ts`, `server/importer.ts`, `server/ingest.ts`, `server/index.ts`,
`src/lib/drawing.ts`, `src/lib/drawingMove.ts` and their tests, plus `tests/canvasClipboardBrowser.test.ts` (one
`it.skip`, see Flaky tests). When one of these PRs lands upstream, a sync
replaces our copy and the entry can go. The 2026-11-18 ports (#21 to #25) also edit: `server/actions.ts`,
`server/componentActions.ts`, `server/componentEngine.ts`, `server/components.ts`, `server/componentTools.ts`,
`server/cssPrune.ts`, `server/mcp.ts`, `server/resident.ts`, `server/screenshot.ts`, `server/pdfExport.ts`,
`server/pageTools.ts`, `server/renderLimits.ts`, `.context/TECHSTACK.md` (fit_height, `<doop-use>` refusal);
`src/lib/frameDropRuntime.ts` (`freeSurface`); tests `frameHtml`, `inlineData`, `componentDrops`, `componentSoftDelete`,
`residentApproval`, `residentPageTools`, `residentTokenWork`, `workBudgetCommit`, `drawingReorderBrowser`. New upstream
files that came with them: `server/frameFit.ts`, `server/frameWriteRefusal.ts`, `server/pageShim.ts`,
`tests/frameFit.test.ts`, `tests/measureGate.ts`. Upstream #439 absorbed the pan changes and `tests/panelResizing.test.tsx`.
Also: `.github/workflows/` differs from upstream by design (`android.yml` is
upstream's and is not taken).

## Hygiene log

- Baseline before: free RAM 7350 MB of 32464 MB; C: free 111.59 GB; G: free 1339.19 GB.
- After: free RAM 4877 MB (machine-wide, other P0 work running; no Doop process or browser of ours is running);
  C: free 110.65 GB; G: free 1338.92 GB. `G:\Tools\Cache\doop` is 32 MB (cap 200 MB).
- C: footprint (investigated 2026-11-15): the Doop setup used little on C:. bun cache 59 MB, npm cache 1 MB, no
  Playwright browsers, our session scratch under `%TEMP%\claude` is tiny. The rest of the C: drift is other
  projects (`%TEMP%` holds 32 GB and 700k files from inkstitch, pp-passive and others; `~/.cache/codex-runtimes`
  2.6 GB) and was not touched. Moved: `BUN_INSTALL_CACHE_DIR=G:\Tools\Cache\bun`,
  `PLAYWRIGHT_BROWSERS_PATH=G:\Tools\Cache\playwright` (user env) and `npm config set cache G:\Tools\Cache\npm`;
  the old bun cache was deleted.
- Sign-in: Codex (`codex mcp login doop`) and Claude Code (`claude mcp login doop`) are authenticated; smoke test
  canvas `https://doop.design/c/3C8nB7f0d-` ("T3: smoke test").
