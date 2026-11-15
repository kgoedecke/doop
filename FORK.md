# Arctic's fork of Doop

Personal-use fork of [kgoedecke/doop](https://github.com/kgoedecke/doop) (AGPL-3.0). Upstream's `README.md`
stays untouched so syncs merge cleanly; everything fork-specific lives in this file and in `docs/agents/`.

- Day-to-day design work runs on hosted Doop (`https://doop.design/mcp`). This fork is not self-hosted.
- `.github/workflows/sync-upstream.yml` merges `upstream/main` into `main` daily, runs typecheck, build and
  tests, and pushes only when they pass. Otherwise it opens one PR (red checks) or one issue (merge conflict).
- The fork owns `.github/workflows/`: upstream changes to it are ignored by the sync (the default
  `GITHUB_TOKEN` cannot push workflow edits, and upstream's release, desktop and CLA automation is not ours).
- Upstream PRs we took are merged as real merge commits, so upstream landing the same change later merges
  cleanly.
- Fork state, upstream PR verdicts and the ranked improvements list: [`docs/agents/STATE.md`](docs/agents/STATE.md).
- Rules for agents working here: [`AGENTS.md`](AGENTS.md).

Fork prerequisites for the sync workflow: Issues enabled on the fork (the workflow opens and closes one issue), and
"Allow GitHub Actions to create and approve pull requests" turned on under Settings, Actions, General.
