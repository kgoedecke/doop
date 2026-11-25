# The doop CLI

`doop` is Doop from a shell, for coding agents (Claude Code, Codex, Cursor) and for scripts and CI. Frames and
components are local files you edit with your own tools; screenshots and exports are written to disk. It works
against doop.design and any self-hosted server, with an [agent key](../README.md#headless-agents-agent-keys).

It complements the MCP server and does not replace it: MCP is the way in for chat clients and for agents
without a shell.

## Install

```bash
npm install -g @doop-design/cli     # or: bun add -g @doop-design/cli, pnpm add -g @doop-design/cli
doop --version
```

Or run it without installing, which suits CI: `npx @doop-design/cli <command>` (`bunx` works the same). It
needs Node 20 or newer and has no dependencies.

Every Doop server also serves the CLI it was built with, as one file. Use that for a self-hosted server that
is older than the latest release, or where no registry is reachable:

```bash
curl -fsSL https://doop.design/cli/doop.mjs -o doop && chmod +x doop
sudo mv doop /usr/local/bin/        # or anywhere on your PATH
```

For a self-hosted server, download from your own origin (`https://your-doop/cli/doop.mjs`) and point the CLI at
it with `DOOP_SERVER`.

## Sign in

```bash
doop login
```

This opens your browser. Sign in to Doop if you aren't, press **Connect the CLI**, and the terminal finishes by
itself. The CLI is handed an agent key named after your machine (`doop CLI on Kevins-MacBook`), saved in
`~/.config/doop/credentials.json`. It shows up, and can be revoked, under **Settings → Agent keys**.

`doop logout` deletes that key again.

On a machine with no browser (over SSH, in a container), `doop login --no-browser` prints a link to open on
any device and takes the code the page shows.

For CI, or anywhere nobody is there to approve, use an agent key directly. Make one under **Settings → Agent
keys**, then either save it or pass it in the environment:

```bash
doop login --key dpk_…              # saved for doop.design
export DOOP_API_KEY=dpk_…           # nothing is written to disk
```

For a self-hosted server, name it: `doop login --server https://your-doop`, or set `DOOP_SERVER`.

| Variable          | What it sets                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `DOOP_API_KEY`    | The agent key                                                       |
| `DOOP_SERVER`     | The server, when it is not https://doop.design                      |
| `DOOP_AGENT_NAME` | The name people see beside the work (default: the agent's own name) |

A key from the environment is sent only to the server you point it at: `DOOP_SERVER`, `--server`, or
doop.design when neither is set. It is never sent to a server that only a repository's `.doop/config.json` or a
canvas URL names, so a cloned repository cannot collect it. A key saved with `doop login` belongs to the server
it was saved for.

## The loop

```bash
doop link "Onboarding v2"           # or a canvas id or URL; --create "Name" makes one
doop pull                           # frames -> designs/*.html, components -> designs/components/
# edit the files
doop push                           # changed files -> the canvas, live for everyone watching
doop screenshot designs/hero.html   # prints the path of a PNG
doop wait                           # blocks until a person leaves feedback or a comment
```

A new design is a new file:

```bash
doop push designs/pricing.html --width 1440 --height 900
```

`doop link` writes `.doop/config.json`, which is meant to be committed so everyone on the repository works on
the same canvas. `.doop/state.json` and the generated files beside it are ignored by git.

To tell the coding agents that work in a repository about Doop, run `doop init`: it adds a short block to
`AGENTS.md` and, with `--skill` or in a repository set up for Claude, a Claude Code skill. Both point the agent
at `doop guide`, which explains the loop and Doop's design conventions.

`doop wait` remembers the newest comment it has seen in `.doop/state.json`, so a comment left while the agent
was busy is the first thing the next `doop wait` reports.

## Conflicts

People edit the same canvas while an agent works. A push carries the version of the frame the file came from,
and the server refuses it (exit code 3) if somebody changed the frame's HTML since:

```bash
doop diff designs/hero.html            # what differs
doop pull designs/hero.html --force    # take the canvas
doop push designs/hero.html --force    # take the file
```

A comment on an element counts as a change, because it adds an id to the markup that an older file would strip.
A frame that was only renamed, moved or approved is not a conflict.

## Components

Each component on the canvas is three files in `designs/components/`:

| File          | Holds                           |
| ------------- | ------------------------------- |
| `button.html` | The template, one root element  |
| `button.css`  | Its rules                       |
| `button.json` | Its name, description and props |

Edit them and `doop push`: every instance on the canvas follows. A new component is a new `.html` there, pushed
by path. In a frame, an instance is a `<doop-use component="Button" label="Save">` tag, so a frame file opened
in a browser does not show its components. To see the real page:

```bash
doop screenshot designs/hero.html   # a PNG of the frame as it renders
doop expand designs/hero.html       # the frame with components and tokens written out, in .doop/expanded/
```

The expanded file is for reading and for implementing a design as code. It is generated: `doop push` refuses
it. `doop pull --ready --expand` fetches the frames a person marked ready for dev together with their expanded
form.

## Commands

| Command                         | What it does                                                        |
| ------------------------------- | ------------------------------------------------------------------- |
| `login`, `logout`, `whoami`     | The saved key, and the account and canvas in use                    |
| `canvases`, `link`              | List canvases; link this directory to one                           |
| `init`                          | Tell the repository's coding agents about Doop                      |
| `guide [topic]`                 | How to design in Doop                                               |
| `frames [--ready]`              | The frames on the canvas                                            |
| `pull`, `push`, `diff`          | Frames and components to and from local files                       |
| `screenshot`, `inspect`         | A PNG of a frame or component; layout problems as data              |
| `expand`                        | A frame as it renders, in a file a browser opens                    |
| `export`                        | Frames as PNG, JPG or one PDF                                       |
| `wait`                          | Block until a person leaves feedback or a comment                   |
| `status "<one line>"`           | Show people what the agent is working on                            |
| `tokens pull`, `tokens push`    | Design tokens as JSON, CSS, Tailwind or markdown; push only changes |
| `asset upload <file or URL>…`   | Upload images and print their URLs                                  |
| `tools [name]`, `call <tool> …` | List the MCP tools; run any of them                                 |

`doop <command> --help` shows a command's options. Every command takes `--json` for one JSON document on
stdout (`ok`, `data`, and `warnings`, `notes` and `feedback` when there are any).

`doop call` reaches everything without a command of its own. Arguments are `key=text` (always a string),
`key:=json` for a number, boolean or list, `key@=file` for a file's contents, or one JSON object; the canvas
and the agent's name are filled in:

```bash
doop call search_icons query=arrow
doop call reply_to_comment comment_id=abc123 text="Done"
doop call get_frame_screenshot frame_id=Wuszc9yhNj scale:=2
```

### Exit codes

| Code | Meaning                               |
| ---- | ------------------------------------- |
| 0    | Done                                  |
| 1    | Failed                                |
| 2    | Wrong usage                           |
| 3    | Conflict with the canvas              |
| 4    | Not signed in, or the key was refused |
| 5    | Not found                             |
| 6    | `doop wait` timed out                 |

## In CI

```yaml
- run: npx @doop-design/cli tokens push tokens.json
  env:
    DOOP_API_KEY: ${{ secrets.DOOP_API_KEY }}
- run: npx @doop-design/cli export --all --format png -o public/designs
  env:
    DOOP_API_KEY: ${{ secrets.DOOP_API_KEY }}
```

`doop inspect <frame> --fail-on-problems` exits 1 when a frame has content past its edge, clipped text or
overlapping elements.

## The agent API

Frame HTML travels over three endpoints, which a script can call without the CLI. They take an agent key as a
bearer token and nothing else. The name in `Doop-Agent` is the one people see beside the work.

```bash
# read: the body is the HTML, the ETag is the frame's version
curl -H "Authorization: Bearer $DOOP_API_KEY" -i https://doop.design/api/v1/frames/<frame id>/html

# replace, only while the frame is still at that version
curl -X PUT -H "Authorization: Bearer $DOOP_API_KEY" -H "Doop-Agent: CI" \
     -H 'Content-Type: text/html' -H 'If-Match: "<version>"' \
     --data-binary @hero.html https://doop.design/api/v1/frames/<frame id>/html

# create
curl -X POST -H "Authorization: Bearer $DOOP_API_KEY" -H 'Content-Type: text/html' \
     --data-binary @hero.html \
     'https://doop.design/api/v1/canvases/<canvas id>/frames?name=Hero&width=1440&height=900'
```

`GET …/html?form=rendered` answers the frame as it renders, with components and token values written out.

A write answers JSON: the `frame` (with its new `version`), `html_changed` when the canvas stored the markup
differently than it was sent, `warnings` for what could not be done as written (an instance of a component that
does not exist), `notes`, and the `feedback` people left for the agent.

| Status | `error.code`   | When                                                              |
| ------ | -------------- | ----------------------------------------------------------------- |
| 400    | `invalid`      | The body is not HTML, a frame has no name, or `If-Match` is wrong |
| 401    | `unauthorized` | No agent key, or one that was revoked                             |
| 403    | `forbidden`    | The account may read the canvas but not change it                 |
| 404    | `not_found`    | No such frame or canvas for this account                          |
| 409    | `conflict`     | The frame moved past `If-Match`; `error.frame` is the frame now   |
| 413    | `too_large`    | More than 10 MB of HTML                                           |
| 422    | `refused`      | The HTML embeds base64 data; upload the file as an asset instead  |

Everything else an agent does (components, tokens, screenshots, comments) goes through the
[MCP tools](architecture/mcp.md), which `doop call` runs.
