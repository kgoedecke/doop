# Iconify screenshot reproduction

Observed November 10, 2026, 01:56–01:59 UTC against the hosted Doop MCP server,
before PR #474. These reproduce the reported symptom; Daniel's original frame
was not available for comparison.

## Hosted results

Test canvas: https://doop.design/c/4xhfxd4ZYd

All icon URLs came from `search_icons`. Each frame used direct external URLs;
none used the proposed Doop cache. Rendered with `get_frame_screenshot`, scale 1.

| Frame        | Input                                                                                 | Result                                                                                       |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `sD4fC3G8go` | 24 home icons, plain and colored (48 images)                                          | All 48 visible                                                                               |
| `dlAZFCs4_r` | 48 arrow icons, each plain, CORS, lazy and CSS background (192 distinct URL variants) | Diagnostic script counted 64/144 images loaded and 80 failed; CSS backgrounds visibly absent |
| `k571jH1YzJ` | One arrow icon, 72 distinct color variants, ordinary eager images                     | Images 1–63 loaded; 64–72 failed                                                             |

The final frame uses `https://api.iconify.design/keyline-icons/arrow-right-sharp.svg`
with `?color=%23<hex>&height=28`, where `<hex>` runs from `000001` through `000048`.
It lays out 72 ordinary `<img width="28" height="28">` elements. On window load,
the diagnostic counts images with `naturalWidth === 0`. A synchronous XHR retry
of the first failed URL also failed, without exposing an HTTP status to the page.

![Hosted screenshot: 63 icons load, the last nine are broken](iconify-72-hosted.png)

## Local network evidence

The 192-request fixture was also rendered in local Chrome, first directly and then
through the unmodified `guardPublicPageRequests` implementation:

- Direct: 149 HTTP 200 responses and 43 `net::ERR_BLOCKED_BY_ORB` request failures;
  101/144 image elements loaded, 43 failed.
- Pinned fetch path immediately afterward: 144 HTTP 429 responses; all 144 image
  elements failed. These runs share an outbound IP, so the second run is not an
  independent comparison of the two implementations.
- A subsequent single SVG request confirmed the rate-limit response below.

```text
2026-11-10 01:59:44 UTC
HTTP/2 429
content-type: text/plain; charset=UTF-8
retry-after: 237
server: cloudflare

error code: 1015
```

Stopped burst requests after receiving this response. Do not run repeated load
tests against the public API without respecting its retry interval.

## What this establishes

Broken hotlinked icons are reproducible in the hosted screenshot tool, and icon
request bursts can trigger upstream rate limiting locally. The hosted failures
cluster near 64 requests, but the screenshot alone does not expose their network
status; do not claim an exact Iconify quota or confirmed hosted root cause from
that count.

PR #474 currently protects previously cached variants from upstream failure.
It still needs a successful initial fetch per variant, so it does not solve cold
bursts. Its own 64-concurrent-miss rejection is also a problem for large icon
grids. Before marking the PR ready, address cold-burst behavior, respect upstream
backoff, and validate the same fixture with the proposed change. Also account for
the hosted off-network renderer path: it continues public requests directly in
Chrome, bypassing a custom `fetchUrl` callback used only by the pinned-fetch path.
