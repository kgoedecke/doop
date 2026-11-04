# Custom Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users save and activate multiple OpenAI-compatible inference profiles, using an API key (optional for local servers), base URL, and custom model id, while safely supporting public providers and local endpoints on self-hosted Doop.

**Architecture:** Add a `custom_model_profiles` table for many saved profiles and add `profile_id` plus the `custom-key` kind to the existing one-row-per-user `model_accounts` active-account record. A focused custom-inference module validates URLs, protects server-side requests against SSRF/DNS rebinding, and reuses the existing Chat Completions translation. The REST and Settings UI expose profile CRUD, connection testing, activation, model selection, and vision capability without ever returning API keys.

**Tech Stack:** TypeScript 5.9 strict mode, Express 4, Drizzle/Postgres/PGlite, Node `dns`/`net`/`undici`, React 18, Zustand-backed existing settings patterns, Vitest 5, existing `sealedText` secret encryption, English + Brazilian Portuguese i18n.

## Global Constraints

- Custom inference speaks OpenAI-compatible **Chat Completions** only; raw-HTTP adapters and custom Anthropic-dialect endpoints are out of scope.
- A user may save multiple custom profiles, but only one model account is active for resident-agent execution at a time.
- `custom_model_profiles` stores the profile source of truth; `model_accounts.profile_id` only identifies the active profile and must not duplicate the API key or endpoint.
- Public custom endpoints require HTTPS; self-hosted local/private endpoints require `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=1`; public HTTP remains forbidden even when private URLs are enabled.
- Reject credentials, query strings, fragments, unsupported schemes, numeric-IP tricks, loopback/private/link-local/multicast/unspecified/cloud-metadata targets by default.
- Resolve and validate the endpoint on every outbound request, pin the approved DNS address for that request, disable redirects, bound timeout and response size, and never let a user-controlled redirect escape validation.
- API keys use the existing `sealedText` mechanism, never appear in profile/status JSON, logs, analytics, or error messages.
- Custom model ids are non-empty, length-bounded strings with a conservative allowed character set; do not apply OpenAI/Gemini family regexes.
- Existing Claude, OpenAI, ChatGPT, OpenRouter, Gemini, local Claude, and server free-tier behavior must remain unchanged.
- Use `clean-code:typescript` for every TypeScript implementation/review task.
- Follow repository formatting: no semicolons, single quotes, 120-column print width, trailing commas.
- Use existing UI primitives and named design tokens; no raw form controls or arbitrary typography/radius classes in migrated components.
- Add all user-facing copy through `src/lib/i18n/en/models.ts` and the mirrored `pt-BR` catalog; preserve catalog parity tests.
- Use test-first development: each task writes focused failing tests before implementation and ends with a targeted test command.

---

## File map and responsibilities

### New files

- `server/customInference.ts` — custom endpoint normalization, URL policy, safe request helper, bounded JSON response handling, and public error types/codes.
- `server/customModelProfiles.ts` — profile domain types, CRUD, active-profile lookup, activation/deactivation, redacted views, and profile-level validation orchestration.
- `server/db/migrations/0044_custom_model_profiles.sql` — creates `custom_model_profiles` and adds `model_accounts.profile_id`.
- `tests/customInference.test.ts` — URL and safe-fetch security tests.
- `tests/customModelProfiles.test.ts` — profile service and HTTP API tests.
- `tests/customInferenceAgent.test.ts` — custom Chat Completions and catalog integration tests, unless the existing transport tests are expanded instead.
- `src/components/CustomModelProfiles.tsx` — Settings profile list and add/edit/test/activate UI, using existing primitives.

### Modified files

- `server/env.ts` — parse `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS`.
- `.env.example` — document the self-host-only private endpoint opt-in.
- `server/db/schema.ts` — define `customModelProfiles`; add nullable `profileId` to `modelAccounts`.
- `server/secretBackfill.ts` — include the new sealed profile API-key column in legacy resealing.
- `server/modelAccounts.ts` — add `custom-key`, profile-aware status/model selection, and activation helpers.
- `server/modelCatalog.ts` — load a custom profile's `/models` catalog without provider-family filtering.
- `server/chatCompletionsAgent.ts` — make safe custom URL requests possible while retaining fixed URL configs for existing providers.
- `server/agentModel.ts` — construct a custom `AgentModel` from the active profile.
- `server/index.ts` — add custom profile routes and include `custom-key` in status/menu types.
- `shared/modelMenu.ts` — add the `custom-key` account label.
- `src/lib/api.ts` — client types and profile endpoint methods.
- `src/components/ModelAccount.tsx` — render custom profile management and custom model selection.
- `src/components/ModelPicker.tsx` — generic custom provider mark behavior/types if required by the new union.
- `src/lib/i18n/en/models.ts` — English profile/security/error strings.
- `src/lib/i18n/pt-BR/models.ts` — matching Portuguese strings.
- `tests/chatCompletionsAgent.test.ts` — preserve existing fixed-provider behavior and add custom request assertions where appropriate.
- `tests/modelCatalog.test.ts` — custom catalog behavior.
- `tests/providerKeyAccounts.test.ts` or a new focused HTTP suite — activation/status/disconnect behavior.
- `README.md` — explain custom profiles and self-hosted local model support.

---

### Task 1: Build the URL policy and safe custom fetch boundary

**Files:**

- Create: `server/customInference.ts`
- Modify: `server/publicUrl.ts:1-168` only if a generalized pinned resolver is needed; preserve existing public-resource behavior.
- Modify: `server/env.ts:148-185`
- Modify: `.env.example` near the server/provider settings and URL settings.
- Test: `tests/customInference.test.ts`

**Interfaces:**

- Produces `CustomInferenceError` with stable codes: `invalid_url`, `url_insecure`, `private_url_blocked`, `unreachable`, `auth_failed`, and `not_compatible`.
- Produces `normalizeCustomBaseUrl(raw: string): URL` for syntactic normalization only.
- Produces `validateCustomBaseUrl(raw: string, allowPrivate: boolean): Promise<URL>` for normalization plus DNS/network policy.
- Produces `customEndpointUrl(baseUrl: URL, path: 'models' | 'chat/completions'): URL`.
- Produces `fetchCustomJson(url: URL, init: RequestInit, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<unknown>`.
- Consumes `env.CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS`.

- [ ] **Step 1: Write failing URL-policy tests.** Cover:
  - bare `https://provider.example/v1/` normalizes to one trailing path form;
  - `ftp:`, malformed URLs, credentials, query strings, fragments, and empty hosts fail with `invalid_url`;
  - public `http://provider.example` fails with `url_insecure`;
  - `https://localhost`, loopback IPs, private IPs, link-local IPs, IPv4-mapped private IPv6, and cloud metadata addresses fail with `private_url_blocked` when private URLs are disabled;
  - the same loopback URL is accepted when `allowPrivate` is true;
  - an HTTPS public host with a DNS result containing a blocked address fails, even if another result is public;
  - `/models` and `/chat/completions` append below a base path without double slashes.

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run:

```bash
bunx vitest run tests/customInference.test.ts
```

Expected: FAIL because the custom-inference exports do not exist.

- [ ] **Step 3: Implement URL parsing and policy.**
  - Parse only absolute HTTP(S) URLs.
  - Reject username/password, search, and hash components.
  - Preserve a user-supplied path, trim trailing slashes, and reject control characters.
  - Require HTTPS for non-private hosts.
  - Reuse the blocked address ranges and pinned lookup pattern from `server/publicUrl.ts`; refactor only the smallest shared portion if needed.
  - Resolve hostnames on every request. If any answer is blocked, reject the request rather than selecting a public answer.
  - For private opt-in requests, still resolve and pin the returned addresses so DNS rebinding cannot redirect the connection after validation.

- [ ] **Step 4: Add bounded request and response handling.**
  - Force `redirect: 'error'`.
  - Compose an `AbortSignal.timeout` with the caller signal, with an 8-second default connection/catalog timeout and a longer bounded turn timeout consistent with resident-agent expectations.
  - Reject a declared response larger than the configured maximum and stop reading once the limit is exceeded.
  - Parse JSON only after bounded reading; never include response bodies or authorization values in thrown errors.
  - Convert 401/403 to `auth_failed`, 404/405 or invalid expected shapes to `not_compatible`, and network/timeouts to `unreachable`.

- [ ] **Step 5: Add the operator flag and documentation.**
  - Add `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS` as an `envalid` boolean with default `false`.
  - Document that it is intended for self-hosted local inference only and does not permit public HTTP.
  - Keep `.env.example` aligned with `server/env.ts` conventions.

- [ ] **Step 6: Run focused tests and commit.**

```bash
bunx vitest run tests/customInference.test.ts tests/publicUrl.test.ts
 git add server/customInference.ts server/publicUrl.ts server/env.ts .env.example tests/customInference.test.ts
 git commit -m "feat: secure custom inference endpoints"
```

Expected: PASS; existing public URL tests remain green.

---

### Task 2: Add profile persistence and redacted profile service

**Files:**

- Modify: `server/db/schema.ts:590-610`
- Create: `server/db/migrations/0044_custom_model_profiles.sql`
- Modify: `server/secretBackfill.ts` sealed-column registry.
- Create: `server/customModelProfiles.ts`
- Test: `tests/customModelProfiles.test.ts`

**Interfaces:**

- Produces `CustomModelProfile` with `{ id, userId, name, baseUrl, model, supportsVision, connectedAt, updatedAt }` and an internal record carrying `apiKey`.
- Produces `CustomModelProfileInput` with `{ name: string; baseUrl: string; apiKey?: string | null; model: string; supportsVision: boolean }`.
- Produces `CustomModelProfileView` with `{ id, name, baseUrl, model, supportsVision, active, connectedAt, updatedAt }`; it must never include `apiKey`.
- Produces `listProfiles(userId)`, `getProfile(userId, id)`, `createProfile(userId, input)`, `updateProfile(userId, id, patch)`, `deleteProfile(userId, id)`, and `profileView(profile, activeProfileId)`.
- Consumes `validateCustomBaseUrl` for save-time validation and the existing `sealedText` column type.

- [ ] **Step 1: Write failing schema/service tests.** Assert:
  - profiles are isolated by `userId`;
  - create normalizes and stores a profile with a sealed key;
  - list/view never returns the key;
  - patching without `apiKey` preserves the key, `apiKey: null` clears it, and a new key replaces it;
  - empty/overlong names and invalid model ids are rejected;
  - deleting an inactive profile removes only that profile;
  - active-profile deletion invokes the active-account disconnect path (the exact account transition is completed in Task 3).

- [ ] **Step 2: Run the focused tests and verify they fail.**

```bash
bunx vitest run tests/customModelProfiles.test.ts
```

- [ ] **Step 3: Add the Drizzle schema and migration.**
  - Create `custom_model_profiles` with a generated string id, non-null `user_id`, `name`, `base_url`, `api_key` using `sealedText`, `model`, `supports_vision`, `connected_at`, and `updated_at`.
  - Add an index on `user_id`.
  - Add nullable `profile_id` to `model_accounts`.
  - Generate the checked-in SQL in the repository’s existing style, preserving migration metadata conventions.
  - Do not add a foreign key that makes deleting a profile silently cascade an active account; the service must perform the explicit disconnect transition.

- [ ] **Step 4: Implement the profile service.**
  - Validate input lengths and model syntax before writing.
  - Use `crypto.randomUUID()` for ids and `Date.now()` for timestamps.
  - Store only `apiKey` in sealed storage; base URL is not secret but must be redacted only where the UI contract requires it.
  - Use user-scoped `where(and(eq(...)))` clauses for every read/update/delete.
  - Return views through one redaction function so no route accidentally leaks the key.
  - Add the new sealed column to `secretBackfill.ts` so legacy plaintext rows are resealed on boot.

- [ ] **Step 5: Run tests, migration/type checks, and commit.**

```bash
bunx vitest run tests/customModelProfiles.test.ts
bun run typecheck
 git add server/db/schema.ts server/db/migrations/0044_custom_model_profiles.sql server/secretBackfill.ts server/customModelProfiles.ts tests/customModelProfiles.test.ts
 git commit -m "feat: store custom inference profiles"
```

Expected: PASS; migration is included and typecheck is clean.

---

### Task 3: Integrate `custom-key` with the active model account

**Files:**

- Modify: `server/modelAccounts.ts:57-235,239-279`
- Modify: `shared/modelMenu.ts:194-203`
- Modify: `server/agentModel.ts:199-283`
- Modify: `src/lib/api.ts:144-193`
- Modify: `tests/providerKeyAccounts.test.ts` or create `tests/customModelProfiles.test.ts`

**Interfaces:**

- Extends `AccountKind` and client `ModelAccountKind` with `'custom-key'`.
- `ModelAccount` gains `profileId?: string`.
- `AccountStatus` gains `profileId?: string` only if the UI needs it; never expose the key.
- Produces `activateCustomProfile(userId: string, profileId: string): Promise<AccountStatus>`.
- Produces `disconnectCustomProfile(userId: string, profileId: string): Promise<void>` or an equivalent guarded helper for deletion.
- `accountModelFor` resolves the active profile’s model through the account record without applying provider-specific regexes.
- `byoModel` consumes an internal profile loaded by the authenticated user and produces a `ChatCompletionsConfig` for the custom endpoint.

- [ ] **Step 1: Write failing active-account tests.** Cover:
  - activating Alice’s profile creates/updates only Alice’s `custom-key` account;
  - the active account stores `profileId` and does not store a duplicate endpoint or key;
  - activation replaces a prior provider account and disables the local-agent preference using the existing switching convention;
  - `GET /api/model-account` reports `custom-key`, active profile id if exposed, and selected model without a key;
  - `PATCH /api/model-account { model }` updates the active custom profile and rejects invalid model syntax;
  - disconnecting removes the active account but leaves saved profiles intact;
  - deleting the active profile disconnects the account and does not affect other profiles.

- [ ] **Step 2: Run the focused tests and verify they fail.**

```bash
bunx vitest run tests/providerKeyAccounts.test.ts tests/customModelProfiles.test.ts
```

- [ ] **Step 3: Extend account storage and policy.**
  - Add `'custom-key'` to `ACCOUNT_KINDS`, `AccountKind`, and `ACCOUNT_KIND_LABELS` as `Custom endpoint`.
  - Read/write `profileId` in `toAccount` and `save`.
  - Add custom policy: resolve to the profile model; accept only the shared custom-model validator.
  - Keep `takesReasoningEffort('custom-key') === false`.
  - Ensure switching existing providers clears `profileId`, and activating custom clears OAuth/API fields without copying the profile secret.
  - Keep `savePick` guarded by both user id and kind; custom model writes must additionally guard the profile id to avoid a stale profile update.

- [ ] **Step 4: Implement `activateCustomProfile` and guarded disconnect behavior.**
  - Confirm the profile belongs to the requesting user.
  - Upsert the one active account with kind `custom-key`, profile id, and no API key/token fields.
  - Disable local Claude preference when changing into a custom account, matching existing provider routes.
  - On profile deletion, conditionally delete the active account only when its `profileId` matches the profile being removed.

- [ ] **Step 5: Wire `byoModel`.**
  - For `custom-key`, load the profile by `userId` + `profileId`; missing profile becomes `ModelAuthError('The selected custom endpoint no longer exists. Choose another profile in Settings.')`.
  - Build a config with the profile’s base URL, model, optional key, profile name, and vision flag.
  - Use the safe request function from Task 1 through the transport rather than raw `fetch`.
  - Map custom auth and compatibility errors to `ModelAuthError` / `ModelUnavailableError` without echoing URL query strings or keys.

- [ ] **Step 6: Run tests/typecheck and commit.**

```bash
bunx vitest run tests/providerKeyAccounts.test.ts tests/customModelProfiles.test.ts tests/anthropicAccount.test.ts
bun run typecheck
 git add server/modelAccounts.ts server/agentModel.ts shared/modelMenu.ts src/lib/api.ts tests/providerKeyAccounts.test.ts tests/customModelProfiles.test.ts
 git commit -m "feat: activate custom inference profiles"
```

---

### Task 4: Extend Chat Completions transport and custom model catalog

**Files:**

- Modify: `server/chatCompletionsAgent.ts:37-73,239-257`
- Modify: `server/modelCatalog.ts:40-249`
- Test: `tests/chatCompletionsAgent.test.ts`
- Test: `tests/modelCatalog.test.ts`
- Create or extend: `tests/customInferenceAgent.test.ts`

**Interfaces:**

- Extends `ChatCompletionsConfig` with a `custom`/safe-request discriminator or a request function that prevents fixed-provider regressions.
- Produces `customConfig(baseUrl: URL, apiKey: string | undefined, model: string, vision: boolean, label: string): ChatCompletionsConfig`.
- Produces `customModels(profile: CustomModelProfile, signal: AbortSignal): Promise<ModelOption[]>`.
- Consumes `fetchCustomJson` and `customEndpointUrl` from Task 1.

- [ ] **Step 1: Write failing transport tests.** Assert:
  - custom config posts to `{base}/chat/completions` with the optional Bearer header;
  - request JSON remains exactly the existing Chat Completions contract (`model`, translated messages, tools, `tool_choice: 'auto'`, `max_tokens`);
  - vision=false still strips image inputs and tool-result images;
  - a 401 maps to `ModelAuthError`/the custom auth code, a 404/405 maps to compatibility failure, and a malformed successful body fails visibly;
  - existing OpenRouter and Gemini configs still use their fixed URLs and existing headers.

- [ ] **Step 2: Run focused tests and verify they fail.**

```bash
bunx vitest run tests/chatCompletionsAgent.test.ts tests/customInferenceAgent.test.ts
```

- [ ] **Step 3: Implement the custom config and safe request selection.**
  - Keep `openrouterConfig` and `geminiConfig` unchanged externally.
  - Add `customConfig` carrying a normalized base URL and optional API key.
  - In `runChatCompletionsTurn`, use `fetchCustomJson` only for the custom config and retain ordinary `fetch` for fixed trusted constants, or route all configs through a transport abstraction that explicitly distinguishes fixed vs custom.
  - Preserve existing body translation and response parsing.
  - Do not add provider-specific parameters such as `reasoning`, `parallel_tool_calls`, or image-generation fields.

- [ ] **Step 4: Write failing custom catalog tests.** Cover:
  - an OpenAI-compatible `{ data: [{ id, created? }] }` response returns model options;
  - ids are passed through without OpenAI/Gemini family filtering;
  - display names are stable and derived from ids when no display name exists;
  - auth, timeout, malformed body, and missing `/models` fall back to `live: false` with the curated/free-text path;
  - profile-specific URL and key are used, never another user’s profile.

- [ ] **Step 5: Implement the catalog loader.**
  - Add a `custom-key` loader in `LOADERS` that loads the active profile and calls its `/models` endpoint through the safe request boundary.
  - Keep only chat-capable shape checks that can be proven from the response; do not reject arbitrary model names based on vendor regexes.
  - Return `ModelOption[]` with `vision` equal to the profile’s explicit `supportsVision` value.
  - Ensure `modelCatalogFor` has an appropriate label and preserves a non-empty fallback if the catalog cannot be reached.

- [ ] **Step 6: Run tests/typecheck and commit.**

```bash
bunx vitest run tests/chatCompletionsAgent.test.ts tests/modelCatalog.test.ts tests/customInferenceAgent.test.ts
bun run typecheck
 git add server/chatCompletionsAgent.ts server/modelCatalog.ts tests/chatCompletionsAgent.test.ts tests/modelCatalog.test.ts tests/customInferenceAgent.test.ts
 git commit -m "feat: run custom models through chat completions"
```

---

### Task 5: Add authenticated profile REST routes and status/catalog integration

**Files:**

- Modify: `server/index.ts:916-1079`
- Modify: `src/lib/api.ts:150-193,510-545`
- Test: `tests/customModelProfiles.test.ts`
- Test: `tests/modelCatalog.test.ts`

**Interfaces:**

- `GET /api/model-profiles` → `CustomModelProfileView[]`.
- `POST /api/model-profiles` accepts `{ name, baseUrl, apiKey?, model, supportsVision }` and returns the created redacted view.
- `PATCH /api/model-profiles/:id` accepts partial `{ name?, baseUrl?, apiKey?, model?, supportsVision? }`; omitted `apiKey` preserves it, null clears it; returns the redacted view.
- `DELETE /api/model-profiles/:id` → `{ ok: true }`.
- `POST /api/model-profiles/:id/activate` → the same `accountView` shape as existing provider connections.
- `POST /api/model-profiles/test` accepts `{ baseUrl, apiKey?, model? }` and returns `{ reachable: boolean; models?: string[]; errorCode?: string; error?: string }`, with no secret echo.

- [ ] **Step 1: Write failing route tests.** Verify:
  - unauthenticated requests are rejected by the existing session gate;
  - Alice cannot read, patch, activate, test, or delete Bob’s profile even with a guessed id;
  - invalid payloads return 400 with stable error codes/messages;
  - create/list/patch/delete responses omit `apiKey` and do not leak it in serialized errors;
  - activation returns complete `accountView` including menus and `custom-key`;
  - `/api/model-account/models` uses the active custom profile;
  - `/api/model-account` model patch writes through to the profile.

- [ ] **Step 2: Run the route tests and verify they fail.**

```bash
bunx vitest run tests/customModelProfiles.test.ts tests/modelCatalog.test.ts
```

- [ ] **Step 3: Implement route handlers.**
  - Parse body fields with explicit runtime checks; do not use unchecked `any`.
  - Use the authenticated `req.user!.id` for all service calls.
  - Map `CustomInferenceError` to 400 with its stable code and a safe human-readable message.
  - Use 404 for profiles that do not belong to the user, matching existing resource behavior without confirming whether another user’s id exists.
  - Keep activation and local-agent switching server-authoritative.

- [ ] **Step 4: Add custom menu/status typing.**
  - Add `custom-key` to `MODEL_MENUS`; its initial menu can be empty because the catalog is profile-specific.
  - Ensure status responses retain `menus` on every route, as existing `accountView` promises.
  - Add client API methods and types for profile list/create/update/delete/test/activate.

- [ ] **Step 5: Run tests/typecheck and commit.**

```bash
bunx vitest run tests/customModelProfiles.test.ts tests/modelCatalog.test.ts tests/providerKeyAccounts.test.ts
bun run typecheck
 git add server/index.ts src/lib/api.ts tests/customModelProfiles.test.ts tests/modelCatalog.test.ts
 git commit -m "feat: expose custom model profile API"
```

---

### Task 6: Build the Settings custom-profile UI

**Files:**

- Create: `src/components/CustomModelProfiles.tsx`
- Modify: `src/components/ModelAccount.tsx:1-20,137-599,601-end`
- Modify: `src/components/ModelPicker.tsx:1-57`
- Modify: `src/lib/i18n/en/models.ts`
- Modify: `src/lib/i18n/pt-BR/models.ts`
- Test: `tests/customModelProfiles.test.tsx` or the repository’s closest component test setup.

**Interfaces:**

- `CustomModelProfiles` accepts `{ account: ModelAccountStatus; onChange?: () => void }` and owns profile list/form state.
- Consumes all `api.modelProfiles*` methods from Task 5.
- Emits refreshed account/profile state to `ModelAccountPanel` through the existing `settle`/`onChange` flow.

- [ ] **Step 1: Write failing component tests.** Cover:
  - empty state shows Add custom endpoint;
  - form requires name, base URL, and model, while API key is optional;
  - the vision toggle is visible and its value is sent;
  - Test connection reports success/error without displaying the key after submission;
  - saved profiles show host/path, model, vision status, and active state but never the API key;
  - Activate calls the correct profile endpoint and refreshes the active account;
  - edit preserves a key when the API key field is left blank and clears it only when explicitly requested;
  - delete asks for the existing confirmation treatment and refreshes the list/account.

- [ ] **Step 2: Run the component test and verify it fails.**

```bash
bunx vitest run tests/customModelProfiles.test.tsx
```

- [ ] **Step 3: Implement the profile component with existing primitives.**
  - Use `SettingsCard`/`CardRow` or the established model-plan primitives already used by `ModelAccountPanel`.
  - Use `Input`, `Switch`/`Checkbox`, `Button`, `AlertDialog`, and existing status/error patterns; do not introduce raw controls.
  - Show the normalized base URL as returned by the server, but never show or log the API key.
  - Keep the edit form’s API key field blank when a key already exists; provide an explicit “replace/clear key” action rather than implying blank means clear.
  - Disable submit/test controls while requests are pending and surface server error codes through translated copy.
  - Add a self-host note explaining that localhost/private URLs require the deployment operator to enable `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS`.

- [ ] **Step 4: Integrate it into `ModelAccountPanel`.**
  - Render the custom-profile section without disrupting existing provider key sections.
  - Refresh profiles and account after create/edit/delete/activate.
  - Do not treat a saved inactive profile as the active resident provider.
  - Keep existing local Claude switching semantics: activating a custom profile disables local Claude; disconnecting restores no provider automatically.

- [ ] **Step 5: Update picker/type behavior and translations.**
  - Add `custom-key` to client unions and make `PROVIDER_MARK` fall back to the existing Doop mark.
  - For active custom accounts, use live catalog options; if live loading fails, show the selected model and a translated catalog warning rather than an empty/broken picker.
  - Add English and Portuguese keys for profile actions, fields, security note, vision, test states, validation errors, activation, deletion, and catalog failures.

- [ ] **Step 6: Run component/i18n/type checks and commit.**

```bash
bunx vitest run tests/customModelProfiles.test.tsx tests/i18n.test.ts
bun run typecheck
bun run lint
 git add src/components/CustomModelProfiles.tsx src/components/ModelAccount.tsx src/components/ModelPicker.tsx src/lib/api.ts src/lib/i18n/en/models.ts src/lib/i18n/pt-BR/models.ts tests/customModelProfiles.test.tsx
 git commit -m "feat: add custom inference profile settings"
```

---

### Task 7: Add end-to-end custom turn and security regressions

**Files:**

- Modify: `tests/customInferenceAgent.test.ts`
- Modify: `tests/chatCompletionsAgent.test.ts`
- Modify: `tests/customModelProfiles.test.ts`
- Modify: `tests/modelCatalog.test.ts`
- Modify: `tests/agentModel.test.ts` if a focused agent-model suite exists; otherwise add assertions to the custom profile suite.

**Interfaces:**

- Consumes the completed profile API, active-account selection, safe fetch, catalog loader, and Chat Completions transport.
- Verifies the externally observable contract rather than private implementation details wherever possible.

- [ ] **Step 1: Add a mock OpenAI-compatible endpoint fixture.**
  - Serve `/v1/models` with a valid model list.
  - Serve `/v1/chat/completions` with one tool call followed by a successful text response.
  - Add routes for 401, 404, malformed JSON, oversized body, redirect, and delayed response.
  - Keep the fixture in a test-only server/handler; never execute downloaded or external scripts.

- [ ] **Step 2: Add the successful end-to-end test.**
  - Create a custom profile with no key against an explicitly allowed local fixture URL.
  - Activate it.
  - Assert catalog models are returned.
  - Assert the resident-agent transport sends the selected custom model, translated tools/messages, and correct vision behavior.
  - Assert the tool call is converted back into the Anthropic-shaped `TurnBlock[]` expected by `resident.ts`.

- [ ] **Step 3: Add security regression tests.**
  - Confirm a redirect to a private host is rejected rather than followed.
  - Confirm a DNS response changing from public to private is rejected on the next request.
  - Confirm private URLs fail when the feature flag is false and work only when the test explicitly enables the flag.
  - Confirm query strings/fragments/credentials never reach the transport.
  - Confirm no API key appears in response JSON, thrown error text, logs captured by the test, or PostHog payloads.

- [ ] **Step 4: Add provider-regression tests.**
  - Existing OpenRouter/Gemini requests retain their fixed URLs and headers.
  - Existing account kinds retain their model regexes and reasoning behavior.
  - Existing model picker/settings tests remain green when `custom-key` is present in the unions.

- [ ] **Step 5: Run the full relevant suite and commit.**

```bash
bunx vitest run tests/customInference.test.ts tests/customInferenceAgent.test.ts tests/customModelProfiles.test.ts tests/chatCompletionsAgent.test.ts tests/modelCatalog.test.ts tests/providerKeyAccounts.test.ts tests/i18n.test.ts
bun run typecheck
bun run lint
 git add tests/customInference.test.ts tests/customInferenceAgent.test.ts tests/customModelProfiles.test.ts tests/chatCompletionsAgent.test.ts tests/modelCatalog.test.ts tests/providerKeyAccounts.test.ts tests/i18n.test.ts
 git commit -m "test: cover custom inference end to end"
```

---

### Task 8: Update product documentation and verify the complete change

**Files:**

- Modify: `README.md` around the connected model account section and environment table.
- Modify: `.env.example` if Task 1 did not complete all documentation there.
- Modify: `.context/TECHSTACK.md` in the model-account/provider section.
- Create or modify: `docs/custom-inference.md` if the README section would otherwise become too long.
- Test/verification: repository-wide typecheck, lint, format check, build, and relevant Vitest suites.

**Interfaces:**

- Documentation must describe the shipped REST/UI behavior, not an aspirational API.
- The docs must clearly distinguish external HTTPS endpoints, self-hosted private endpoints, and hosted doop.design limitations.

- [ ] **Step 1: Document user behavior.** Include:
  - Settings → Doop Agent → Custom endpoint profile flow;
  - multiple saved profiles and one active profile;
  - base URL examples such as `https://provider.example/v1` and self-hosted `http://127.0.0.1:11434/v1`;
  - optional API key for local servers;
  - explicit vision toggle and degraded no-screenshot behavior;
  - OpenAI-compatible Chat Completions requirement.

- [ ] **Step 2: Document operator security configuration.** State that:
  - the server performs model requests;
  - keys are encrypted and never returned to the browser;
  - public endpoints must use HTTPS;
  - private/local URLs work only on self-hosted deployments with `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=1`;
  - hosted Doop cannot reach a user’s localhost/LAN through this feature.

- [ ] **Step 3: Run formatting and all CI-equivalent checks.**

```bash
bun run format:check
bun run typecheck
bun run lint
bun run build
bun run test
```

Expected: all commands pass. If a command fails, fix the underlying issue and rerun the failed command before claiming completion.

- [ ] **Step 4: Review the final diff for secret/SSRF regressions.**
  - Search for custom API-key serialization, logging, analytics capture, raw custom `fetch`, and `redirect: 'follow'`.
  - Confirm every custom outbound request uses the safe helper.
  - Confirm every profile query is user-scoped.
  - Confirm `custom-key` is present in every relevant server/client union and absent from image-generation provider assumptions unless explicitly unsupported.

```bash
git diff --check
grep -R "apiKey" -n server/index.ts server/customModelProfiles.ts src/components/CustomModelProfiles.tsx
 grep -R "fetch(.*profile\|fetch(.*baseUrl\|redirect: 'follow'" -n server
```

- [ ] **Step 5: Commit documentation and final verification.**

```bash
git add README.md .env.example .context/TECHSTACK.md docs/custom-inference.md
 git commit -m "docs: document custom inference profiles"
```

---

## Spec coverage self-review

- Multiple saved profiles: Tasks 2, 3, 5, and 6.
- One active account pointer: Task 3.
- OpenAI-compatible Chat Completions: Task 4 and Task 7.
- External public endpoints: Task 1 HTTPS/DNS policy and Task 7 regression tests.
- Self-hosted local models: Task 1 operator flag, Task 6 explanatory UI, Task 8 docs.
- SSRF, DNS rebinding, redirects, bounded responses/timeouts: Tasks 1 and 7.
- Encrypted keys and no browser/log leakage: Tasks 2, 5, 6, and 7.
- Custom model ids and live `/models` catalog: Tasks 2, 4, and 5.
- Existing provider behavior preserved: Tasks 3, 4, and 7.
- REST API: Task 5.
- Settings and composer UI: Task 6.
- i18n parity: Task 6 and Task 8 verification.
- Documentation/configuration: Task 1 and Task 8.
- Migration and secret resealing: Task 2.

## Plan self-review

- No placeholder steps remain; each implementation area names files, interfaces, tests, commands, and expected outcomes.
- Type names are consistent across tasks: `custom-key`, `CustomModelProfile`, `CustomModelProfileView`, `profileId`, `customConfig`, and `fetchCustomJson`.
- The transport boundary is explicit: fixed provider URLs remain unchanged, while custom requests go through the SSRF-safe path.
- The profile key is stored once in `custom_model_profiles`; `model_accounts` stores only the active profile pointer.
- The design’s one potential ambiguity — whether `/models` is mandatory — is resolved consistently: catalog failure does not prevent saving or running a manually entered model.
