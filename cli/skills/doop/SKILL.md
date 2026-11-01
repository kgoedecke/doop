---
name: doop
description: Use when a user asks to design or edit a Doop canvas, connect an agent to local Doop, or troubleshoot a local Doop instance.
---

Use the connected Doop MCP tools for canvas work. Call `get_guide` before editing
and follow the returned design and canvas rules. Read the target canvas first;
preserve unrelated frames and user work. Verify the result using the MCP tools.

For local setup, run `doop service status --json`. If no server is running and
the user wants a local instance, run `doop service start`. `doop pair` prints the
MCP endpoint; `doop pair --client NAME` configures Codex, Claude, Cursor or OpenCode
and leaves authentication to that client's MCP OAuth flow.

For API work, use `doop api GET /api/canvases`. A CLI account session is established
through `doop auth login`; never put passwords into command arguments or logs.
JSON bodies can be passed as `--data @file.json`. Inspect responses and check the
user's intended canvas before mutations. API requests use existing access controls.

For startup failures, use `doop doctor --json` and `doop debug paths`. Logs may
contain private user data; inspect only what is needed and do not publish them.
`doop reload` restarts the managed backend while preserving its data and URL.
