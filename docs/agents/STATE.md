# Fork state (ArcticSlayy/doop)

Last updated: 2026-11-14 (lead session)

## Purpose

Arctic's personal fork of [kgoedecke/doop](https://github.com/kgoedecke/doop) (AGPL, personal use). Day-to-day
design work stays on hosted Doop (`https://doop.design/mcp`); the fork carries upstream PRs worth having and
Arctic's own improvements. It is **not self-hosted**: no dev server, docker or heavy builds locally until
Arctic OKs the RAM (self-hosting on `localhost:4300` waits for that and for improvements worth running).

## Sync

- Synced to upstream SHA: `2b257e2b8ff64eb37f4835930ee6118052872c45` (2026-11-10, "fix(components): fix four
  component review findings").
- Automation: `.github/workflows/sync-upstream.yml`, daily 09:23 UTC plus manual dispatch. It runs on GitHub, with no
  local scheduled task. Green: pushes to `main`. Red: parks the merge on `sync/upstream` and opens one PR.
  Conflict: opens one issue, pushes nothing. Nothing new: does nothing.
- The fork owns `.github/workflows/` (upstream's changes there are ignored by the sync).
- Merge-friendly rule: our changes go in NEW files (FORK.md, docs/agents/, AGENTS.md), not edits to upstream
  files. Upstream's README is untouched.
- Next sync: automatic, daily.

## Open upstream PRs (34 on 2026-11-14) and verdicts

Taken (each needs ONE Sol review before merging into our `main`; dropped after two rejections):

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

| PR                 | Reason                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------- |
| 505                | Security hardening: out of scope for now (Arctic dropped the security pass)              |
| 439, 434           | Perf tweaks: out of scope for now (optimization dropped)                                 |
| 515                | macOS WebKit launch panic: we are on Windows                                             |
| 514                | Sends agent signals to a third-party service (Glassray): privacy, no value to us         |
| 509, 437, 435      | Draft PRs                                                                                |
| 500, 433           | 8-10k line canvas-actors rewrite for flagged hosted owners: huge, hosted-only, high risk |
| 465, 447           | release-please version bump PRs: upstream release bookkeeping                            |
| 450, 449           | Low value (Run shortcut hijacks reload; proxy IP header only matters when self-hosting)  |
| 474, 457, 456, 433 | Conflict with upstream main (upstream author's own, will be rebased there)               |
| 412, 339, 301, 299 | Conflict with upstream main                                                              |
| 281, 277, 166, 141 | Conflict with upstream main, stale (older than a month or unmaintained)                  |
| 436                | Conflicts with upstream main                                                             |

## Merged into our main

_(updated as PRs land: number, our PR, Sol verdict)_

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
- A "lite mode": no Chromium, no screenshots, minimal memory, for a RAM-constrained machine.

## Touched upstream files

None so far. All additions are new files: `FORK.md`, `AGENTS.md`, `docs/agents/STATE.md`,
`.github/workflows/sync-upstream.yml`.

## Hygiene log

- Baseline before: free RAM 7350 MB of 32464 MB; C: free 111.59 GB; G: free 1339.19 GB.
