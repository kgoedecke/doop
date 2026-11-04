# Custom inference for the Doop Agent — design

**Goal.** Let a user connect the Doop Agent to any OpenAI-compatible endpoint by base URL, API key, and model id — public hosted providers and, on self-hosted Doop, local servers such as Ollama / LM Studio / vLLM.

**Non-goals.** Raw-HTTP adapters, Anthropic-dialect custom endpoints, changing external-agent (MCP client) connectivity, and changing the server free-tier provider.

## Architecture

Doop's resident agent is written against Anthropic-shaped message/tool structures. `server/chatCompletionsAgent.ts` already translates those into OpenAI-compatible **Chat Completions** and back — it currently only ever speaks to fixed endpoint constants (OpenRouter, Gemini), because a user-supplied URL is a server-side fetch target (SSRF). This feature makes that transport accept a *validated* user endpoint and adds the storage/profile surface to manage it.

Two storage concepts stay separate:

- **`custom_model_profiles`** (new table) — the saved address book. Many per user: `id`, `user_id`, `name`, normalized `base_url`, sealed `api_key` (nullable — local servers take no key), `model`, `supports_vision`, timestamps. Profiles are edited here; the key is never duplicated elsewhere.
- **`model_accounts`** (existing, one row per user) — remains the *active* account the resident agent runs on. Activating a custom profile writes a row with `kind = 'custom-key'` and a `profile_id` pointing at the profile. A custom account resolves its URL/key/model/vision **from the profile row at run time** — editing the profile changes the live account with no second write.

`pickModel(payerId)` is unchanged in shape. `byoModel` gains a `custom-key` branch that loads the profile and builds a `ChatCompletionsConfig`: `url = {base}/chat/completions`, `Authorization: Bearer <key>` only when a key is present, `label = profile.name`, `vision = profile.supportsVision`. `runChatCompletionsTurn` then does the turn as today — so every tool, image-strip-on-no-vision, and stop-reason mapping is shared with OpenRouter/Gemini.

A custom model id is a free-form validated string (non-empty, sane charset/length), not an OpenAI/Gemini regex — providers name models arbitrarily.

## Endpoint security

The server makes every request; the browser never calls the model endpoint and never receives the key. Redirects are disabled, timeouts and response sizes are bounded, keys go only in `Authorization: Bearer`, and `sealedText` encrypts the key at rest (never returned by any profile/status endpoint, never logged).

**URL validation** on create/edit *and re-validated on every request* (DNS answers can change): normalize; no credentials, query, or fragment; HTTPS required for public endpoints; `base_url` may carry a path (`/v1`) to which `/chat/completions` and `/models` are appended.

**SSRF.** Default deployment blocks loopback, private, link-local, multicast, unspecified, and cloud-metadata ranges — hostname resolved before each fetch, any blocked answer refuses, numeric-IP tricks and non-HTTP(S) schemes rejected.

**Local models.** Operator opt-in for self-hosts:

```
CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=1
```

allows loopback/private URLs (`http://127.0.0.1:11434/v1`) while still forbidding plain-HTTP to public hosts. Hosted doop.design leaves the flag unset and so can never reach a user's machine or LAN — matching "local models are self-host only."

## API surface

Beside the existing `/api/model-account`:

- `GET /api/model-profiles` — list profiles (id, name, normalized base URL, model, supportsVision, `active` flag; never the key).
- `POST /api/model-profiles` — create { name, baseUrl, apiKey?, model, supportsVision }.
- `PATCH /api/model-profiles/:id` — edit; `apiKey: null` clears, omitted keeps; URL re-validated.
- `DELETE /api/model-profiles/:id` — remove; deleting the active profile disconnects the custom account.
- `POST /api/model-profiles/:id/activate` — sets `model_accounts` to `custom-key` + `profile_id` (replaces whatever account was connected).
- `POST /api/model-profiles/test` — probe `{base}/models` before saving; reports reachable / auth / shape. A probe failure warns but does not block saving — some servers expose no models endpoint, and a typed model still works.

`GET /api/model-account` reports `kind: 'custom-key'` with the resolved model; `PATCH /api/model-account { model }` writes through to the active profile so the composer picker and Settings stay consistent. `modelCatalogFor` gains a `custom-key` loader fetching `{base}/models` (ids passed through unfiltered — no family assumptions); failure returns `live: false` and the UI falls back to free-text model entry.

## UI

Settings → Doop Agent gains a **Custom endpoint** card: saved profile list, an Add/Edit modal (name, base URL, optional API key, model, "this model can see images" toggle), a **Test connection** action, and Activate. The composer `ModelPicker` needs no changes — a custom account shows the profile's catalog; the provider mark falls back to `DoopMark` for `custom-key`. All copy via `useT()`, both `en` and `pt-BR` catalogs.

## Errors

Validation/transport failures carry codes the editor maps to sentences: `invalid_url`, `url_insecure`, `private_url_blocked`, `unreachable`, `auth_failed`, `not_compatible`. Run-time failures surface in the Agents panel like any provider (`ModelAuthError` → "check your endpoint/key in Settings"; 404 / method-not-allowed → "endpoint is not OpenAI-compatible"). A broken BYO profile is never silently absorbed by the free tier.

## Testing

- URL validation/normalization units (schemes, credential/query rejection, private/loopback blocked vs allowed by flag).
- Profile CRUD + activate + model pick; secret never leaked in any response.
- `customFetch`: redirects off, timeout, per-request DNS re-resolve honors blocks.
- `byoModel` wiring: `custom-key` → config from profile → `runChatCompletionsTurn`.
- Catalog loader: `/models` success, failure → free-text.
- Mock OpenAI-compatible server (Ollama-style shapes) for an end-to-end turn.

## Docs / config

`.env.example` gains `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS`; README "connect your own" section documents the Custom endpoint card and the self-host/local-model rule. Migration adds `custom_model_profiles` and `model_accounts.profile_id` via `npx drizzle-kit generate`.
