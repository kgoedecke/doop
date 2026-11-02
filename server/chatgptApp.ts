/* The ChatGPT app surface of the MCP server. ChatGPT (and any MCP Apps host)
   can render an HTML component next to a tool result; here that is a preview
   card showing the frames a tool just touched, rendered from the public
   /i/<frame>.png route, with a button that opens the canvas. The model keeps
   getting the same text results it always did — the component only reads
   `structuredContent`, so other MCP clients are unaffected.

   Two generations of host API coexist: the MCP Apps standard
   (`_meta.ui.*`, `text/html;profile=mcp-app`, `ui/notifications/tool-result`
   over postMessage) and ChatGPT's original aliases (`openai/outputTemplate`,
   `window.openai.toolOutput`). Both are declared and both are read, so the
   component works whichever one the host speaks. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { env } from './env.ts'
import type { Frame } from '../shared/types.ts'

/* Hosts cache the component by URI, so a change to the markup or script
   below must bump the version or linked users keep the old card. A chat
   that holds a retired URI fails with "Failed to fetch template", so a
   bumped version is ADDED to RETIRED_PREVIEW_URIS, never replaced. */
const PREVIEW_VERSION = 2
export const FRAME_PREVIEW_URI = `ui://doop/frame-preview-${PREVIEW_VERSION}.html`
export const RETIRED_PREVIEW_URIS: readonly string[] = ['ui://doop/frame-preview-1.html']
const PREVIEW_MIME = 'text/html;profile=mcp-app'

export type FramePreview = {
  id: string
  name: string
  width: number
  height: number
  /** public PNG render of the frame's CURRENT design, cache-busted per edit.
   *  Scale 1 on purpose: it is what `get_frame_screenshot` renders by default,
   *  so the card's load is usually a cache hit, and a 1x frame is already far
   *  wider than a chat card. */
  image_url: string
  /** the canvas, scrolled to this frame */
  url: string
  /** no HTML yet (created, not streamed into): the card shows a placeholder
   *  instead of rendering a blank artboard */
  empty: boolean
}

export type CanvasPreview = {
  canvas: { id: string; name: string; url: string }
  frames: FramePreview[]
}

const origin = () => env.BETTER_AUTH_URL

/** The structured result every previewable tool returns alongside its text. */
export function previewOf(canvas: { id: string; name: string }, frames: Frame[]): CanvasPreview {
  const canvasUrl = `${origin()}/c/${canvas.id}`
  return {
    canvas: { id: canvas.id, name: canvas.name, url: canvasUrl },
    frames: frames.map((f) => ({
      id: f.id,
      name: f.name,
      width: f.width,
      height: f.height,
      image_url: `${origin()}/i/${f.id}.png?scale=1&v=${f.updatedAt}`,
      url: `${canvasUrl}?frame=${f.id}`,
      empty: f.html.trim().length === 0,
    })),
  }
}

/** Tool `_meta` that links a tool to the preview component. The invoking /
 *  invoked strings are the status ChatGPT shows while the call runs (64 chars max). */
export function previewToolMeta(invoking: string, invoked: string): Record<string, unknown> {
  return {
    ui: { resourceUri: FRAME_PREVIEW_URI },
    'openai/outputTemplate': FRAME_PREVIEW_URI,
    'openai/toolInvocation/invoking': invoking,
    'openai/toolInvocation/invoked': invoked,
  }
}

const WIDGET_DESCRIPTION =
  'Shows a rendered preview of the Doop frames this tool touched, with a button that opens the canvas.'

/** Registers the component resource. One per server instance; the host
 *  fetches it once per URI and caches it, so the URI doubles as a version. */
export function registerFramePreview(server: McpServer): void {
  for (const uri of [FRAME_PREVIEW_URI, ...RETIRED_PREVIEW_URIS]) registerPreviewResource(server, uri)
}

function registerPreviewResource(server: McpServer, uri: string): void {
  server.registerResource(
    `doop-frame-preview-${uri.replace(/\W+/g, '-')}`,
    uri,
    { title: 'Doop frame preview', description: WIDGET_DESCRIPTION, mimeType: PREVIEW_MIME },
    async () => ({
      contents: [
        {
          uri,
          mimeType: PREVIEW_MIME,
          text: framePreviewHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              domain: origin(),
              csp: { connectDomains: [], resourceDomains: [origin()] },
            },
            'openai/widgetDescription': WIDGET_DESCRIPTION,
            'openai/widgetPrefersBorder': true,
            'openai/widgetDomain': origin(),
            'openai/widgetCSP': { connect_domains: [], resource_domains: [origin()], redirect_domains: [origin()] },
          },
        },
      ],
    }),
  )
}

/* The component: no framework, no build step, nothing fetched but the frame
   images. Everything it needs arrives as `structuredContent` (a CanvasPreview);
   it re-renders whenever the host hands it a new one.

   Two host dialects. MCP Apps: the page posts `ui/initialize` to its parent,
   acknowledges with `ui/notifications/initialized`, then receives
   `ui/notifications/tool-result` (and theme changes) as JSON-RPC
   notifications; links open through a `ui/open-link` request. ChatGPT's
   original API: the result sits on `window.openai.toolOutput`, updates fire
   `openai:set_globals`, and `window.openai.openExternal` opens links. The
   script speaks both and uses whichever answers.

   The CSS reads the host's design tokens (`--color-background-primary` …)
   with fallbacks, so inside ChatGPT the card takes the thread's surface and
   text colours instead of bringing its own. */
export function framePreviewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    color-scheme: light dark;
    --surface: var(--color-background-primary, #ffffff);
    --well: var(--color-background-secondary, #f3f3f6);
    --ink: var(--color-text-primary, #17171b);
    --ink-soft: var(--color-text-secondary, #5c5c66);
    --line: var(--color-border-primary, #e4e4ea);
    --brand: #e5533c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
      --surface: var(--color-background-primary, #151518);
      --well: var(--color-background-secondary, #1e1e23);
      --ink: var(--color-text-primary, #f3f3f6);
      --ink-soft: var(--color-text-secondary, #a0a0ab);
      --line: var(--color-border-primary, #2c2c33);
    }
  }
  :root[data-theme='dark'] {
    --surface: var(--color-background-primary, #151518);
    --well: var(--color-background-secondary, #1e1e23);
    --ink: var(--color-text-primary, #f3f3f6);
    --ink-soft: var(--color-text-secondary, #a0a0ab);
    --line: var(--color-border-primary, #2c2c33);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font: 14px/1.4 var(--font-family-base, -apple-system, "Segoe UI", Inter, Roboto, sans-serif); color: var(--ink); background: var(--surface); -webkit-font-smoothing: antialiased; }
  .wrap { padding: 14px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { color: var(--ink-soft); font-size: 12px; }
  .open { flex: none; appearance: none; border: 0; border-radius: 999px; background: var(--brand); color: #fff; font: inherit; font-weight: 600; font-size: 13px; padding: 7px 14px; cursor: pointer; }
  .open:hover { filter: brightness(0.95); }
  .grid { display: grid; gap: 12px; align-items: start; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  .grid.one { grid-template-columns: 1fr; }
  .card { border: 1px solid var(--line); border-radius: var(--border-radius-md, 12px); overflow: hidden; background: var(--well); }
  .card a { display: block; text-decoration: none; color: inherit; }
  .shot { display: block; width: 100%; background: var(--well); object-fit: contain; object-position: top; }
  .meta { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; background: var(--surface); border-top: 1px solid var(--line); font-size: 12px; }
  .meta b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta span { color: var(--ink-soft); flex: none; }
  .empty { color: var(--ink-soft); font-size: 13px; margin: 0; }
  .shot.missing { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 96px; color: var(--ink-soft); font-size: 12px; }
  .retry { appearance: none; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink); font: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer; }
  .card.more { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 120px; color: var(--ink); text-decoration: none; font-weight: 600; font-size: 14px; }
  .card.more span { color: var(--ink-soft); font-weight: 400; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap" id="root"><p class="empty">Waiting for the canvas…</p></div>
<script>
(function () {
  var root = document.getElementById('root');
  var latest = null;
  /* Each image is a metered render on the public /i/ route (12 per minute per
     anonymous IP, and the sandbox iframe sends no cookies). Showing at most
     this many keeps a cold canvas inside that budget; the rest are one click away. */
  var MAX_SHOWN = 6;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---- MCP Apps bridge: JSON-RPC over postMessage to the host frame ---- */
  var bridge = { connected: false, nextId: 1, pending: {} };
  function post(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) { /* no host */ } }
  function request(method, params) {
    var id = bridge.nextId++;
    post({ jsonrpc: '2.0', id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { bridge.pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }

  function setTheme(theme) {
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  }

  function open(href) {
    var api = window.openai;
    if (api && typeof api.openExternal === 'function') { api.openExternal({ href: href }); return; }
    if (bridge.connected) { request('ui/open-link', { url: href }).catch(function () { window.open(href, '_blank', 'noopener'); }); return; }
    window.open(href, '_blank', 'noopener');
  }

  function reportSize() {
    if (!bridge.connected) return;
    notify('ui/notifications/size-changed', { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) });
  }

  function render(data) {
    if (!data || !data.canvas) { root.innerHTML = '<p class="empty">Nothing to preview yet.</p>'; reportSize(); return; }
    var frames = Array.isArray(data.frames) ? data.frames : [];
    var html = '<div class="head"><div><div class="title">' + esc(data.canvas.name || 'Canvas') + '</div>' +
      '<div class="sub">' + (frames.length === 1 ? '1 frame' : frames.length + ' frames') + ' · Doop</div></div>' +
      '<button class="open" type="button" data-href="' + esc(data.canvas.url) + '">Open in Doop</button></div>';
    if (!frames.length) html += '<p class="empty">This canvas has no frames yet.</p>';
    else {
      var shown = frames.slice(0, MAX_SHOWN);
      html += '<div class="grid' + (frames.length === 1 ? ' one' : '') + '">';
      for (var i = 0; i < shown.length; i++) {
        var f = shown[i];
        var ratio = f.width && f.height ? f.width + ' / ' + f.height : '4 / 3';
        var shot = f.empty
          ? '<div class="shot missing" style="aspect-ratio:' + esc(ratio) + '; max-height: 240px;"><span>Design in progress</span></div>'
          : '<img class="shot" src="' + esc(f.image_url) + '" alt="' + esc(f.name) + '" loading="lazy" style="aspect-ratio:' + esc(ratio) + '; max-height: 480px;" />';
        html += '<div class="card"><a href="' + esc(f.url) + '" data-href="' + esc(f.url) + '">' + shot + '</a>' +
          '<div class="meta"><b>' + esc(f.name) + '</b><span>' + esc(f.width) + '×' + esc(f.height) + '</span></div></div>';
      }
      if (frames.length > shown.length) {
        var rest = frames.length - shown.length;
        html += '<a class="card more" href="' + esc(data.canvas.url) + '" data-href="' + esc(data.canvas.url) + '">+' + rest + ' more frame' + (rest === 1 ? '' : 's') + '<span>Open in Doop</span></a>';
      }
      html += '</div>';
    }
    root.innerHTML = html;
    var links = root.querySelectorAll('[data-href]');
    for (var j = 0; j < links.length; j++) links[j].addEventListener('click', function (e) { e.preventDefault(); open(this.getAttribute('data-href')); });
    var imgs = root.querySelectorAll('img');
    for (var k = 0; k < imgs.length; k++) watch(imgs[k]);
    reportSize();
  }

  /* A failed load is almost always the render budget (HTTP 429 from /i/):
     keep the slot, say so, and offer a retry rather than dropping the frame. */
  function watch(img) {
    img.addEventListener('load', reportSize);
    img.addEventListener('error', function () { missing(img); });
  }
  function missing(img) {
    var box = document.createElement('div');
    box.className = 'shot missing';
    box.style.aspectRatio = img.style.aspectRatio;
    box.innerHTML = '<span>Preview not ready yet</span><button class="retry" type="button">Retry</button>';
    box.querySelector('.retry').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var again = document.createElement('img');
      again.className = 'shot'; again.alt = img.alt; again.style.cssText = img.style.cssText;
      again.src = img.src.replace(/&r=\\d+$/, '') + '&r=' + Date.now();
      watch(again);
      box.parentNode.replaceChild(again, box);
    });
    img.parentNode.replaceChild(box, img);
    reportSize();
  }

  function apply(data, source) {
    if (!data || typeof data !== 'object' || data === latest) return;
    latest = data;
    render(data);
  }

  /* MCP Apps: the host posts JSON-RPC into the frame */
  window.addEventListener('message', function (e) {
    var m = e && e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && bridge.pending[m.id]) { var done = bridge.pending[m.id]; delete bridge.pending[m.id]; if (m.error) done.reject(m.error); else done.resolve(m.result); return; }
    if (m.method === 'ping' && m.id != null) { post({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
    if (m.method === 'ui/notifications/tool-result' && m.params && m.params.structuredContent) apply(m.params.structuredContent, 'tool-result');
    if (m.method === 'ui/notifications/host-context-changed' && m.params && m.params.theme) setTheme(m.params.theme);
  });
  request('ui/initialize', { appInfo: { name: 'Doop frame preview', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
    .then(function (result) {
      bridge.connected = true;
      notify('ui/notifications/initialized');
      if (result && result.hostContext && result.hostContext.theme) setTheme(result.hostContext.theme);
      reportSize();
    })
    .catch(function () { /* the host refused the handshake: stay unconnected so links fall back to window.open */ });

  /* ChatGPT's original API: the result is on window.openai; updates announce
     themselves with openai:set_globals. A remounted card may get no new
     tool-result at all, so this is also the rehydration path. */
  function fromGlobals() {
    var api = window.openai;
    if (!api) return;
    if (api.theme) setTheme(api.theme);
    if (api.toolOutput) apply(api.toolOutput, 'toolOutput');
  }
  window.addEventListener('openai:set_globals', fromGlobals);
  fromGlobals();
})();
</script>
</body>
</html>`
}
