# doop

[Doop](https://doop.design) from a shell, for coding agents (Claude Code, Codex, Cursor), scripts and CI. Frames
and components on a Doop canvas become local files you edit with your own tools; screenshots and exports are
written to disk.

```bash
npm install -g @doop-design/cli     # or: bun add -g, pnpm add -g
```

Or run it without installing: `npx @doop-design/cli <command>`. Needs Node 20 or newer.

## Use

```bash
doop login                          # opens your browser to approve this machine
doop link "Onboarding v2"           # a canvas name, id or URL; --create "Name" makes one
doop pull                           # frames -> designs/*.html, components -> designs/components/
# edit the files
doop push                           # changed files -> the canvas, live for everyone watching
doop screenshot designs/hero.html   # prints the path of a PNG
doop wait                           # blocks until a person leaves feedback or a comment
```

`doop init` tells the coding agents that work in a repository about Doop, and `doop guide` explains the loop and
Doop's design conventions to them. `doop help` lists every command.

For CI, sign in with an agent key from **Settings → Agent keys**: `doop login --key dpk_…`, or set
`DOOP_API_KEY`. For a self-hosted server, name it: `doop login --server https://your-doop`, or set `DOOP_SERVER`.

## Docs

Commands, conflicts, components, CI use and the HTTP API underneath: <https://doop.design/docs/cli>.

Doop is open source under the GNU AGPL v3: <https://github.com/doop-design/doop>.
