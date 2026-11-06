# Custom inference endpoints

Doop can run the built-in Doop Agent on any server that speaks the OpenAI-compatible **Chat
Completions** API. A user saves one or more endpoints in **Settings → Doop Agent → Custom
endpoints**, then picks one to run on. The endpoint and its key stay on the server; the browser only
ever receives a redacted profile.

This is for inference behind a user's own account, for example a hosted provider or a model server
running on the same machine as a self-hosted Doop. It is not a way to reach a laptop or LAN from
hosted Doop: the server makes the outbound request, so the endpoint must be reachable **from the
server**.

## Add and select a model

- **Name** — a label such as `Local Ollama`.
- **Base URL** — the OpenAI-compatible API root, for example:
  - hosted: `https://provider.example/v1`
  - self-hosted local: `http://127.0.0.1:11434/v1`
- **API key** — optional. Local model servers usually do not need one; hosted providers do.
- **Can see images** — turn this on only when the model accepts image inputs. When it is off, the
  agent degrades to no screenshot review and verifies through frame HTML instead.

You do not need to know or type a model id for the normal setup. Choose **Test connection**; Doop
requests `<base URL>/models` (normally `/v1/models`) and offers the ids it discovers. Select one of
those ids, then save the profile. The test lists models only; it does not save the profile or send a
chat completion. Editing the URL or API key invalidates that test, so test the new configuration
before saving.

If the endpoint has no `/models` route, returns no usable models, or cannot be reached, Doop keeps a
saved model id visible instead of silently changing it. For a new or changed profile, you can
explicitly choose **Use an unverified model id** and enter an id such as `qwen3.5-coder` or
`vendor/designer-9`. This manual id is unverified: Doop could not confirm it against the endpoint's
catalog, and the endpoint may reject it at runtime. A missing saved id is shown with a warning; it
is never silently replaced by another model.

Profiles are saved independently from the active account. Saving several is fine; only one can be
active for resident-agent work at a time. **Use this endpoint** makes it the active account and
switches the local Claude CLI preference off, matching the other provider connection flows.
Disconnecting leaves no provider selected until another account is connected.

When this custom endpoint is active, choosing a different model in the chat composer updates the
saved profile's model too. Settings and the composer therefore use the same model selection.

The API key is sealed on the server and never returned to the browser. When editing a profile, a
blank key field keeps the stored key; clearing it is a separate explicit action. Requests go to
`<base URL>/models` and `<base URL>/chat/completions`.

## Operator configuration

Custom endpoints are disabled by default for private targets. Public endpoints must use HTTPS.

```dotenv
# Self-hosted deployments only: allow loopback, LAN and other private addresses.
# This never permits public HTTP.
CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=true
```

With the flag unset or `false`:

- Public `https://` endpoints work.
- Public `http://` endpoints are refused.
- `localhost`, loopback, private, link-local, multicast and cloud-metadata addresses are refused,
  even over HTTPS.

With `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=true`, loopback/LAN endpoints over HTTP or HTTPS are
allowed so a self-host can reach Ollama, LM Studio, vLLM or another local server. Public endpoints
must still use HTTPS, and hosted Doop still cannot reach a user's computer.

This is an operator decision, not a per-user setting. A hosted deployment should leave it off,
because the server would otherwise make requests into its own network.

## Security model

- The base URL is parsed and normalized before saving: absolute `http`/`https` only, no embedded
  credentials, query string or fragment.
- Every outbound request resolves the hostname again and applies the address policy. DNS is pinned
  for that one connection, so a hostname that changes to a private address after saving is blocked
  on the next request.
- Redirects are refused; a redirect cannot escape validation.
- Requests have a bounded timeout and response size.
- Profile API keys are encrypted with the same sealed-secret mechanism as provider keys. They are
  never returned by the profile, status or catalog JSON, and never appear in error messages.
- A profile belongs to one user. Listing, editing, activating, testing and deleting another user's
  profile id returns "not found" without confirming that it exists.

## HTTP API

All routes require a signed-in session.

| Method   | Route                              | Purpose                                                     |
| -------- | ---------------------------------- | ----------------------------------------------------------- |
| `GET`    | `/api/model-profiles`              | List this user's profiles, redacted, with `active` markers  |
| `POST`   | `/api/model-profiles`              | Create `{ name, baseUrl, apiKey?, model, supportsVision }`  |
| `PATCH`  | `/api/model-profiles/:id`          | Update fields; omit `apiKey` to keep it, `null` to clear it |
| `DELETE` | `/api/model-profiles/:id`          | Delete a profile; the active account is dropped with it     |
| `POST`   | `/api/model-profiles/:id/activate` | Make it the active account; returns the account view        |
| `POST`   | `/api/model-profiles/test`         | Test `{ baseUrl, apiKey?, model? }` without saving          |

The test route returns `{ reachable, models?, errorCode?, error? }`. Stable error codes are
`invalid_url`, `url_insecure`, `private_url_blocked`, `unreachable`, `auth_failed` and
`not_compatible`.

Chat Completions support is the only dialect. A raw-HTTP adapter or a custom Anthropic-dialect
endpoint is out of scope.
