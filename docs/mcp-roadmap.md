# Doop MCP roadmap

Adjustments derived from the Paper MCP comparison (Aug 2026). Ordered by dependency
and value: phases 1–3 are the "efficient editing" arc, 4–6 build outward from it.

## Phase 1 — Addressability substrate

Everything else builds on this.

1. **`annotateHtml` module** — server-side pass (Bun `HTMLRewriter`) injecting stable
   `data-doop-id` attributes on section-level elements. Segment by tree fan-out +
   subtree weight; semantic tags / headings / meaningful classnames are bonus signals
   only (div soup must work). Idempotent: never renumber existing ids; per-frame id
   counter persisted on the frame record.
2. **Wire into every write path** — `create_frame`, `set_frame_html`,
   `append_frame_html` (annotate the accumulated document, not fragments),
   `edit_frame_html` results, `import_webpage`.
3. **Geometry harvesting** — the screenshot service also collects
   `getBoundingClientRect()` per `data-doop-id`, cached per frame version. Large
   rendered regions with no tag get promoted to sections (self-healing pass).
4. **Strip `data-doop-*` on human-facing HTML export** (copy-code paths); keep in the
   live DOM (stable ids also improve morph keying).

## Phase 2 — Efficient read/edit tools

5. **`get_frame_outline(frame_id, depth?)`** — indented skeleton: tag, ids/classes,
   text snippet, child count, byte size, position (from cached boxes).
6. **`get_frame_html(frame_id, selector)`** — outerHTML of one matched element;
   error on 0 or >1 matches.
7. **Selector-based edits** — fold `edit_frame_html` into a single `edit_frame`
   accepting batched ops `{selector, set_text | set_styles | set_attrs |
replace_html | remove}` OR the existing `old_str`/`new_str`. One tool, one
   decision point.
8. **`duplicate_frame(frame_id)`** — server-side deep clone, auto-placed.
9. **`get_frame_screenshot` gains `annotate: true`** — section boxes + ids drawn on
   the image so agents can resolve "the hero" visually.

## Phase 3 — Import quality

10. **Capture-time slimming in `import_webpage`** — Chrome CSS Coverage during
    render, snapshot DOM, strip all `<script>`, prune CSS via coverage ∪ dropcss
    selector-matching, minify with Lightning CSS. Target: 400KB captures →
    30–60KB frames.
11. **Capture-time annotation** — geometry-based `data-doop-id` sectioning while
    Puppeteer has the page live (imports get the best segmentation of all).

## Phase 4 — Guide & taste content

Cheap, high leverage, no code risk — can ship anytime. Paper's guide is ~50% taste
curriculum; that is their real moat and we have evidence (inspo-recipe experiment)
that injected taste beats model defaults.

12. **Rewrite `get_guide` as a taste + workflow curriculum** — the guide is the
    STABLE layer: principles only (mood-word palette method, anti-cliché pairing
    blocklist, anti-first-instinct mood pick, typography doctrine), workflow
    rituals. Recipes themselves never live in the guide. NOTE: the mandatory
    retrieval step in the brief ("name a retrieved recipe or state none fits")
    ships together with the inspo layer (20/12b), not before — until then the
    brief derives from principles only.
    - **12a. Inspo research pipeline** — curate gallery exemplars and distill new
      style recipes (extends the inspo-recipe experiment). Recipes live entirely
      in the retrieval layer (20); the guide only mandates looking them up.
      Ongoing content work, not a one-off.
    - NOTE (from testing): the redesign workflow is a second entry point that
      bypasses the brief — when the retrieval mandate returns, the redesign
      section needs its own hook: Direction A stays anchored to the source
      brand; Direction B must retrieve category inspiration and name its
      exemplars in the redesign guideline doc.
    - **12b. Interim bridge** — until `search_inspiration` exists, ship the five
      existing recipes (CRAV, Oatside, Datacurve, Ponder, Feather) as retrievable
      guidelines (global tier or per-canvas) so the guide's retrieval mandate has
      something real to hit. Manual testing of recipes happens here first; the
      Phase 5 tools later replace the plumbing without changing the workflow.
13. **Mandatory design brief ritual** — on a fresh canvas, agents post a brief
    (mood candidates, chosen mood + why not first instinct, palette with roles,
    type scale, direction) via `set_status` + `save_decision` before the first
    `create_frame`.
14. **Named critique rubric** — upgrade REVIEW_NUDGE into a checklist (spacing,
    typography, contrast, alignment, frame fit, repetition) + one-line verdict.
15. **Hard rules** — never nuke-and-rewrite a frame for small fixes; no raw frame
    IDs in user-facing text; placeholder content self-brands as Doop (never Figma/
    Sketch/Paper); device presets on `create_frame` (`preset: "mobile" | "desktop"`).

## Phase 5 — Assets & generation

One tool per asset class in the product map (fonts, icons, logos, images,
patterns, videos, inspiration). Conventions: `search_*` returns visible
thumbnails plus hotlinkable URLs; generation is metered and explicit-request-only.

16. **`search_fonts`** — Google Fonts by name or vibe; rendered specimen previews
    via the screenshot service so agents SEE fonts before choosing.
17. **`generate_pattern`** — procedural SVG/CSS backgrounds (mesh gradients, grain,
    dot grids, waves, blobs, topo lines); seeded/deterministic, token-recolorable,
    zero AI cost. Differentiator: output is inline SVG/CSS, not raster.
18. **`doop-gen://` URL scheme** — AI image generation intercepted on any write
    path (à la Paper's `paper-gen://`): placeholder renders immediately, real
    asset morphs in when generation completes. Zero new tool surface. Include an
    SVG model for editable vector output.
19. **`search_videos`** — Pexels/Coverr stock loops (thumbnail, duration,
    muted-loop-ready MP4 URL). No video generation.
20. **`search_inspiration` + `get_style_recipe`** — curated gallery thumbnails +
    distilled recipes (productizes the inspo experiment; content from 12a).
    Adopt Mobbin's granularity split (screens / sections / flows); picking a
    result pins it as a canvas reference. Complementary to Mobbin's MCP, not a
    catalog competitor — recipes and canvas-memory integration are the moat.
21. **`get_brand(domain)`** — logo + brand colors + fonts via the existing
    Brandfetch wiring in `search_logos`.

## Phase 6 — Differentiators (what Paper structurally can't follow)

22. **`get_presence` + element-pinned feedback** — canvas click-to-select resolves
    to nearest `data-doop-id`; selection rides the feedback channel ("change this
    ↦ frame + section"). MCP regroup: move `set_status`/`get_feedback` out of
    "Canvas memory" into a "Presence & collaboration" group.
23. **Canvas design tokens** — `:root` CSS vars injected into every frame; editing
    a token restyles the whole canvas live. Tailwind v4 namespaces (`--color-*`,
    `--text-*`, `--radius-*`, …); `get_tokens(format: css | tailwind)` for export.
24. **`publish_frame(frame_id, slug?)`** — hosted live URL; the frame IS a real
    page. Complements `export_frame` image URLs.
25. **Pixel tools** — `get_frame_analytics` / `get_heatmap` (annotated-screenshot
    overlay) on published designs. Closes design → publish → measure → optimize.
26. **Flow graph first-class** — `link_frames` / `get_flow`, generalizing the
    design-sync flow map so agents design journeys, not screens.
27. **`list_decisions(canvas_id)`** — read side of `save_decision`.
28. **PDF/deck export** — canvas → multi-page PDF ordered by frame position.

## Quick wins

- 12–15 (guide content), 8 (`duplicate_frame`), 27 (`list_decisions`).

## Strategic path

- 1 → 2 → 3 in order; the annotation pass is the substrate under 5–9, 11 and 22.
