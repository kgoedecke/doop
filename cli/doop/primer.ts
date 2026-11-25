/**
 * What an agent needs to know to use the CLI. MCP clients are handed Doop's server instructions
 * when they connect; a shell hands an agent nothing, so `doop guide` prints this ahead of the
 * guide and `doop init` leaves a pointer to it where the agent's harness looks.
 */

export const PRIMER = `# Doop from the command line

Doop is a shared design canvas: frames are HTML documents that render live for everyone on the
canvas. This CLI is Doop's MCP tool set shaped for a shell. Frames are local files you edit with
your own tools, and images land on disk instead of in your context.

## The loop

  doop link <canvas>          once per directory; \`doop canvases\` lists them, --create "Name" makes one
  doop pull                   the canvas's frames -> designs/*.html, its components -> designs/components/
  (edit the files)
  doop push                   changed files -> the canvas, live for everyone watching
  doop screenshot <file>      prints the path of a PNG: open it and look. Do this after every push.
  doop inspect <file>         overflow, clipped text and overlaps, as data
  doop wait                   blocks until a person leaves feedback or a comment (run it in the background)

## Rules

- A new design is a new file: write designs/pricing.html, then
  \`doop push designs/pricing.html --width 1440 --height 900\`.
- Keep every data-doop-* attribute you find in a file: comments, links and prototype wiring hang
  on them. When push says it rewrote a file (the canvas stores some markup differently, such as
  a component instance), read the file again before the next edit.
- Exit code 3 is a conflict: someone changed the frame on the canvas since your pull.
  \`doop diff <file>\` shows it; \`doop pull <file> --force\` takes theirs, \`doop push <file> --force\` yours.
- Components: each is three files in designs/components/ (button.html is the template with one
  root element, button.css its rules, button.json its name, description and props). Edit them and
  push, and every instance on the canvas follows. A new one is a new .html there (with .css and
  .json if it needs them). In a frame, an instance is \`<doop-use component="Button" label="Save">\`:
  never redraw a component's markup by hand. Before the first screen of a new product, write its
  component system (Button, Input, the nav, a card), then compose screens from it.
- A frame file with <doop-use> shows no component in a browser. \`doop screenshot\` shows the real
  page; \`doop expand <file>\` writes it with every component and token written out, to read or
  open (never edit or push that file). To implement approved designs as code:
  \`doop pull --ready --expand\`.
- Colours, fonts and sizes are design tokens, written var(--name). \`doop tokens pull\` lists them;
  \`doop tokens push tokens.json\` adds or changes them. Never a palette on a frame's :root.
- Images: \`doop asset upload ./logo.svg\` prints a URL to reference. Never a base64 data: URI.
- A line starting HUMAN FEEDBACK is a request from a person on the canvas: handle it before your plan.
- \`doop status "Designing the pricing page"\` shows people what you are working on; "" clears it.
- Only a person marks a frame ready for dev.

## Everything else

The guide names MCP tools. Each one is \`doop call <tool> key=text ...\` (key:=json for a
number, boolean or list, key@=file for a file's contents; canvas_id and agent_name are filled in for you); \`doop tools\` lists them and \`doop tools <name>\` shows one's arguments.
Where the guide says get_canvas use \`doop frames\`; get_frame / set_frame_html / append_frame_html /
edit_frame_html are pull, edit the file, push; get_frame_screenshot is \`doop screenshot\`;
inspect_frame is \`doop inspect\`; export_frame is \`doop export\`; get_feedback is \`doop wait\`;
upload_asset is \`doop asset upload\`; get_component / create_component / update_component are the
files in designs/components/ and get_component_preview is \`doop screenshot\` on one of them.
Instance overrides, libraries, comments, prototypes, imports and searches go through \`doop call\`. Add --json to any command for one JSON document on stdout.
`

export const SKILL = `---
name: doop
description: Design on a Doop canvas from the shell with the doop CLI. Use when asked to design, mock up or redesign a screen, page or component in Doop, to implement a Doop frame as code, or to sync design tokens or assets with a Doop canvas.
---

# Doop

This project is linked to a Doop canvas (\`.doop/config.json\`). Use the \`doop\` CLI.

1. Run \`doop guide\` once and follow it: it explains the loop and Doop's design conventions.
2. \`doop pull\`, edit the HTML files, \`doop push\`, then \`doop screenshot <file>\` and look at the image.
3. When the work is with a person for review, run \`doop wait\` in the background; it exits when they answer.

\`doop help\` lists every command.
`

export const AGENTS_BLOCK_START = '<!-- doop:start -->'
export const AGENTS_BLOCK_END = '<!-- doop:end -->'

export const AGENTS_BLOCK = `${AGENTS_BLOCK_START}
## Doop

Designs for this project live on a Doop canvas (\`.doop/config.json\`). Work on them with the
\`doop\` CLI: run \`doop guide\` once and follow it, then \`doop pull\`, edit the HTML files,
\`doop push\`, and check with \`doop screenshot <file>\`. \`doop wait\` blocks until a person leaves
feedback. \`doop help\` lists every command.
${AGENTS_BLOCK_END}`
