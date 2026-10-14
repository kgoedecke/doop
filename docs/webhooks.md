# Outbound webhooks

doop can POST a signed JSON event to URLs you register when something happens
on a canvas you can open. It is the push counterpart of polling `get_comments`
over MCP: route comments to Slack, hand finished agent work to an issue
tracker, trigger an n8n flow — anything with an HTTP endpoint.

## Setup

1. Open **Settings → Webhooks**, paste the URL and pick the events.
2. Copy the signing secret. It is shown once; **Rotate secret** issues a new one.
3. Click **Send test** — doop POSTs a `ping` and shows the HTTP status it got back.

A webhook belongs to your account and fires for every canvas you own, were
invited to, or that lives in one of your workspaces. Canvases you only reach
through a share link do not count. You can have up to 10.

## Events

| `type`             | When                                               | Extra fields                                |
| ------------------ | -------------------------------------------------- | ------------------------------------------- |
| `comment.created`  | a comment is pinned to an element                  | `actor`, `comment`, `frame`                 |
| `comment.replied`  | a reply lands in a thread                          | `actor`, `comment`, `frame`                 |
| `comment.resolved` | a thread (or a lone reply) is resolved             | `actor`, `comment`, `frame` (may be `null`) |
| `frame.created`    | a frame is created, by a person or an agent        | `actor`, `frame`                            |
| `task.completed`   | an agent finishes a board card                     | `actor`, `task`                             |
| `task.failed`      | an agent fails a board card (it waits for a retry) | `actor`, `task`, `reason`                   |
| `ping`             | the **Send test** button                           | `message`                                   |

Events fire the same way whether the change came from the browser or an agent
over MCP.

## Delivery

```http
POST /your/url HTTP/1.1
Content-Type: application/json
User-Agent: doop-webhooks/1
X-Doop-Event: comment.created
X-Doop-Delivery: evt_8f1Kq2pZ0mVt
X-Doop-Timestamp: 1791216000000
X-Doop-Signature: sha256=5d41402abc4b2a76b9719d911017c592…
```

```json
{
  "id": "evt_8f1Kq2pZ0mVt",
  "type": "comment.created",
  "at": 1791216000000,
  "canvas": { "id": "k3Yx9", "name": "Landing page", "url": "https://doop.example.com/c/k3Yx9" },
  "actor": { "name": "Alice", "kind": "user" },
  "comment": {
    "id": "zEkW1Tep",
    "frameId": "f1",
    "parentId": null,
    "from": "Alice",
    "text": "Can the heading be larger?",
    "at": 1791216000000,
    "forAgent": false,
    "targetAgent": null,
    "resolvedBy": null,
    "resolvedAt": null,
    "url": "https://doop.example.com/c/k3Yx9?frame=f1&comment=zEkW1Tep"
  },
  "frame": { "id": "f1", "name": "Hero", "x": 0, "y": 0, "width": 1440, "height": 900, "url": "…?frame=f1" }
}
```

`actor.kind` is `user` or `agent`; on `comment.resolved` only the name is known.
Frames carry name and geometry, never their HTML. Tasks carry `id`, `title`,
`agentName`, `queuedBy`, timestamps, `failureReason` and the `frameIds` the
agent touched.

Answer with any 2xx within 10 seconds. Redirects are not followed and count as
failures. A failed delivery is retried after 10 s, 1 min and 5 min, then
dropped; retries are in memory, so a server restart drops them too. A webhook
that fails 100 deliveries in a row pauses itself — turn it back on in Settings.

## Verifying the signature

The signature is HMAC-SHA256 over `<X-Doop-Timestamp>.<raw request body>` with
the webhook's secret, hex-encoded and prefixed with `sha256=`. Verify against
the raw bytes, before any JSON parsing, and reject timestamps older than a few
minutes to shut out replays.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret, headers, rawBody) {
  const timestamp = headers['x-doop-timestamp']
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const given = headers['x-doop-signature'] ?? ''
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
```

In n8n, a **Webhook** node with _Raw body_ on, followed by a **Crypto** node
(HMAC, SHA256, your secret, input `{{ $headers['x-doop-timestamp'] }}.{{ $rawBody }}`)
and an **IF** comparing it with the header, is the whole pipeline.

## Private addresses

Because the server opens a connection to whatever URL you give it, addresses on
its own network are refused by default: `localhost`, loopback, link-local and
RFC 1918 / unique-local ranges, checked at registration and again at every
delivery (DNS answers can change). A self-host whose n8n or Mattermost lives on
the same Docker network opts in by setting `WEBHOOK_ALLOW_PRIVATE_URLS=true` on
the doop server.
