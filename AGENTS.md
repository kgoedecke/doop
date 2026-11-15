# AGENTS.md (ArcticSlayy/doop fork)

Rules for agents working in this fork. Project conventions for the code itself are in `CLAUDE.md` and
`.context/`. State and decisions live in `docs/agents/STATE.md`.

## Rules

- **Merge-friendly fork.** Put our changes in NEW files wherever possible; avoid editing upstream files, so the
  daily upstream sync stays conflict-free. Fork notes go in `FORK.md` or `docs/agents/`, never in upstream's
  `README.md`. If an upstream file must change, keep the edit small and list it in STATE under "Touched
  upstream files".
- **Upstream PRs.** Review each open PR on kgoedecke/doop. Take the worthwhile ones into our `main` through a
  PR in ArcticSlayy/doop, with ONE Sol review (codex, `gpt-6.1-sol`, read-only) before merging. Drop a PR
  after two Sol rejections. Skip stale, conflicting or low-value PRs with a one-line reason in STATE.
- **Sync.** `.github/workflows/sync-upstream.yml` runs on GitHub (daily and on demand). Never create a local
  scheduled task for it. On a red run, fix via the PR it opened; on a conflict, resolve by hand as the issue
  says. `sync/upstream` is bot-owned and gets rewritten.
- **Never** push to or open PRs on kgoedecke/doop.
- **No self-hosting** (no dev server, docker, or heavy builds locally) until Arctic OKs the RAM. Static review
  and light lint/typecheck only; at most one install or test job at a time. Cache and screenshots go under
  `G:\Tools\Cache\doop`, capped and pruned; nothing large on C:.
- Our own improvements are listed in STATE; don't build them until Arctic picks one.
