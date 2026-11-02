# Doop for Cursor

Design on [Doop](https://doop.design) with Cursor while your team watches and edits the same canvas. The plugin connects Cursor to Doop's hosted MCP server and includes the `doop-design` skill for canvas work and implementing designs in a codebase.

## Connect now

On a Doop canvas, choose **Connect AI → Cursor → Add to Cursor**. Cursor asks you to review the MCP connection, then sign in to Doop in your browser. There is no file to download, Node process to run, or API key to paste. This installs the MCP connection; the bundled skill is distributed with the plugin.

In Cursor's Agent chat, send the canvas prompt from Doop or a request such as:

> Work on this Doop canvas: https://doop.design/c/YOUR_CANVAS_ID. Design a pricing page that follows its existing guidelines.

The server supplies its current design instructions on connection. Changes appear live in Doop, and the agent can inspect screenshots to refine its work. Your Doop account must have access to the canvas. A Doop model-provider API key is not required when using your own Cursor agent.

## Plugin installation

This source package is ready for review; it is **not yet listed in the public Cursor Marketplace**. After Cursor approves the listing, users can find Doop in Cursor's **Customize** panel and install it at user or project scope. They then enable the `doop` server and complete its OAuth sign-in. There is no manual file download.

Teams can import `https://github.com/kgoedecke/doop` from **Dashboard → Plugins & MCPs → Team Marketplaces** after the plugin change has been synced to that public repository. The repository's `.cursor-plugin/marketplace.json` points to this `cursor-plugin/` directory. Availability and install policy depend on the team's Cursor plan and settings.

If you previously added Doop through an MCP install link or a manual config, keep only one active connection to that endpoint when installing the plugin.

## What is included

- `.cursor-plugin/plugin.json`: plugin identity, metadata, and component paths.
- `mcp.json`: one remote HTTP connection to `https://doop.design/mcp`, authenticated with OAuth.
- `skills/doop-design/SKILL.md`: a scoped workflow that loads Doop's live guide, reads canvas context, and reviews screenshots.
- `assets/logo.png` and `LICENSE`: Doop's logo and AGPL-3.0 license.

The plugin has no executable hooks, shell commands, bundled runtime, or embedded credentials. Doop enforces the signed-in account's canvas access on server requests. Authorizing the connection allows the agent to read and modify accessible designs; disconnect it from Cursor when it is no longer needed.

## Local plugin development

The package is a directory, so no build or ZIP is required. To test its discovery, copy the complete directory (including its hidden manifest) from this checkout:

```sh
mkdir -p ~/.cursor/plugins/local
cp -R cursor-plugin ~/.cursor/plugins/local/doop
```

Use an empty destination for the first copy. For later iterations, replace the files in that test copy. Run **Developer: Reload Window** in Cursor and confirm that Customize shows the `doop` MCP server and the `doop-design` skill. Cursor ignores symlinks pointing outside its local plugin directory. Local plugin imports must be allowed by your organization; an installed marketplace plugin with the same name takes precedence.

This plugin always targets the hosted service. To test against your local Doop server, use **Connect AI → Cursor** on that local instance instead; its Add to Cursor link uses the current instance's `/mcp` URL. Cursor running on your machine can access localhost. Cloud agents need a publicly reachable endpoint. Do not commit a local URL or test credentials to the production plugin.

Before submission, test in Cursor with a test account and canvas:

1. Confirm plugin discovery after reloading and sign in through the `doop` server.
2. Request the Doop guide, inspect a canvas, create a frame, and review its screenshot.
3. Restart Cursor and confirm the connection can resume.
4. Disconnect the server and verify it stops making calls.

## Marketplace submission

Development happens in the private `design-multiplayer` repository. Before submission, a maintainer must sync this change to the public `https://github.com/kgoedecke/doop` repository through the existing cherry-pick workflow. Confirm both `.cursor-plugin/marketplace.json` and `cursor-plugin/` are present at the same paths on its published branch. There is no OSS export script or automatic public sync. Do not submit the private development repository.

A maintainer then submits the public repository URL at [Cursor's publishing page](https://cursor.com/marketplace/publish). Cursor reviews plugins before listing them and reviews updates. Do not advertise a marketplace URL or install command until Cursor has approved the listing and assigned its identifier.

Use the root marketplace manifest to select **doop** from `cursor-plugin/`. Confirm the plugin name is available, provide any publisher details requested by Cursor, and include a working reviewer sign-in path to a test canvas. Increment the plugin's version when shipping updates.

The marketplace package follows the same repository-manifest pattern used by [Paper's plugin](https://cursor.com/marketplace/paper). Its MCP transport connects directly to the hosted Doop service.

References: [Cursor plugin reference](https://cursor.com/docs/reference/plugins), [installation and local testing](https://cursor.com/docs/plugins), and [MCP install links](https://cursor.com/docs/mcp/install-links).
