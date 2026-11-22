# Hosted integration discovery

[integrations.sh already detects Doop's hosted MCP endpoint](https://integrations.sh/doop.design/).
These files let Doop declare its connection details and give users a direct path to setup.

## Publish on doop.design

Copy the files below into the marketing site's public directory, preserving their paths.

| File                                                      | Public path                            | Content type                |
| --------------------------------------------------------- | -------------------------------------- | --------------------------- |
| [Integration declaration](.well-known/integrations.json)  | `/.well-known/integrations.json`       | `application/json`          |
| [MCP server card](.well-known/mcp/server-card.json)       | `/.well-known/mcp/server-card.json`    | `application/json`          |
| [Product and setup links](llms.txt)                       | `/llms.txt`                            | `text/plain; charset=utf-8` |
| [API catalog](.well-known/api-catalog)                    | `/.well-known/api-catalog`             | `application/linkset+json`  |
| [OpenAPI document](openapi.json)                          | `/openapi.json`                        | `application/json`          |
| [Agent skills index](.well-known/agent-skills/index.json) | `/.well-known/agent-skills/index.json` | `application/json`          |

Serve them publicly over HTTPS with `Cache-Control: public, max-age=3600`. Allow cross-origin GET
requests to the server card with `Access-Control-Allow-Origin: *`.
Keep `/mcp`, `/api`, and the existing OAuth discovery routes on the app backend. The [server card fields
used here](https://integrations.sh/publishing/) describe the default OAuth flow. The declaration
also lists bearer keys as an alternative for headless clients.

The [REST API](../../README.md#rest-api) uses a browser session cookie. The OpenAPI document covers
listing and reading canvases. [Outbound webhooks](../webhooks.md) send events to customer URLs.
External agents connect through MCP, and self-hosted clients use their own instance URL.
An A2A agent card would require an A2A endpoint. Doop's agent integration uses MCP.

The [skills index](https://github.com/cloudflare/agent-skills-discovery-rfc) points to the existing
Doop design skill at a pinned GitHub commit. When the skill changes, update the URL to the new
commit and recompute the SHA-256 digest from the raw bytes served at that URL.

## Connect and verify a canvas edit

For Codex, add the hosted server under a distinct name if you already have a local Doop connection.

```sh
codex mcp add doop-hosted --url https://doop.design/mcp
codex mcp login doop-hosted
```

For Claude Code, run `claude mcp add --transport http doop-hosted https://doop.design/mcp`,
then open `/mcp` in Claude Code and authenticate. Sign in to Doop and approve the connection
in your browser. If the client asks you to reconnect, repeat its login step.

1. Use a disposable canvas with a frame and connect as an account that can edit it.
2. Ask the client to call `get_canvas` with the canvas ID and identify the frame ID.
3. Ask it to call `update_frame` with that `frame_id`, a new `name`, and its `agent_name`.
4. Ask it to call `get_canvas` again and confirm the new name for the same frame ID. Reload the
   canvas in Doop to confirm the edit persisted.

## Verify after deployment

Run these requests from this directory. Check for HTTP 200, the content types above and the
expected bodies. Comparing the response to the checked-in file also catches a successful HTML
fallback. Use the updated files for comparison if the marketing site revises the copy.

```sh
for path in .well-known/integrations.json .well-known/mcp/server-card.json llms.txt \
  .well-known/api-catalog openapi.json .well-known/agent-skills/index.json; do
  curl -fsS -D /dev/stderr "https://doop.design/$path" | diff - "$path" || exit 1
done
```

Check that [root protected-resource metadata](https://doop.design/.well-known/oauth-protected-resource)
and [MCP-specific metadata](https://doop.design/.well-known/oauth-protected-resource/mcp) both point
to `https://doop.design/mcp` and that [authorization-server metadata](https://doop.design/.well-known/oauth-authorization-server)
still advertises the registration endpoint. In a fresh MCP client, confirm initialization and
tool listing after OAuth. Repeat the rename with a viewer account and confirm the edit is rejected.
With a second account that has no access to the canvas, confirm `get_canvas` cannot read it.

On [Doop's integrations.sh listing](https://integrations.sh/doop.design/), run **Map integration
surface** to refresh discovery. Check that the six files above and the existing OAuth metadata are
detected, the design skill is listed, and the MCP and REST credentials are shown separately.
Then discover Doop in Executor, connect to the MCP
surface, and run the disposable-canvas workflow above to check the authenticated connection.

When the MCP host, transport or auth options change, update the published files and rerun these checks.
