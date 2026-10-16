# ChatGPT plugin package

The package uploaded to platform.openai.com/plugins to list Doop in the ChatGPT plugin directory.
The server side (tool annotations, the preview card, OAuth discovery) lives in `server/`; this
folder is only the listing: `plugin.json` (identity, listing copy, review test cases), `mcp.json`
(points ChatGPT at `https://doop.design/mcp` with OAuth + dynamic client registration) and the logo.

Build the ZIP with `node scripts/build-chatgpt-plugin.mjs` (writes `chatgpt-plugin/dist/doop.zip`,
gitignored). Before uploading, replace `review.demo_recording_url` with a reviewer-accessible video.
Reviewer test credentials are entered in the dashboard (Metadata & Skills → Review information),
never in this package. Process and field limits: `.context/specs/chatgpt-app.md`.
