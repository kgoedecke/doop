---
name: doop-design
description: Create, inspect, and refine HTML designs on a shared Doop canvas. Use when the user asks to work in Doop, provides a Doop canvas URL, or asks to implement a design from a Doop canvas in their codebase.
---

# Doop design

Use the connected `doop` MCP server for Doop work. The server provides the current tool schemas and design guidance; do not substitute local HTML files for edits the user requested on a shared canvas.

1. Call `get_guide({ topic: "doop-instructions" })` before other Doop tools and follow the returned workflow. Reload it if the conversation has lost that context.
2. Use the canvas ID from the user's `/c/<id>` URL or explicit canvas ID. If they have not identified a canvas, use the available discovery tools and ask them to choose when the target is ambiguous. Do not guess or create a replacement canvas for an existing design.
3. Pick one `agent_name` and keep it consistent. Read the canvas with `get_canvas`, then fetch its relevant guidelines and references before designing. Announce progress with `set_status` as described by the server.
4. Make the requested changes through the available Doop tools. Inspect the rendered result with `get_frame_screenshot`, correct visual issues, and respond to feedback from people on the canvas. Clear your status when finished.
5. When the user asks to implement a Doop design in their codebase, inspect the source frame and its screenshot first, then follow the repository's conventions. Modify the shared canvas only when the user requests design changes.
6. Finish with a link to the canvas and a brief description of the work completed.

If Doop tools are missing or authentication fails, ask the user to enable the Doop MCP server in Cursor's Customize panel and complete its browser sign-in. Do not request tokens in chat. This plugin connects to `https://doop.design/mcp`; local and self-hosted Doop instances use their own server connection.
