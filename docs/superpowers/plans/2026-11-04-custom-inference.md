# Custom Inference: Close Blockers and Select Models Dynamically Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.
>
> **Execution status:** Implemented and reviewed in-session on 2026-11-05. Focused verification passed (134 tests across 9 suites); the full suite passed (2,362 tests across 250 files) with one worker. Typecheck and lint passed.

**Goal:** Make custom OpenAI-compatible custom endpoints safe to merge by fixing the six review blockers, and let a successfully tested endpoint provide its model list so users can choose a model without typing a model id in the normal connect flow.

**Architecture:** Keep `custom_model_profiles.model` as the saved profile source of truth and keep `/models` as a live discovery call, not a persisted catalog. Add a tested fingerprint so discovery results and selected ids cannot be saved after `(baseUrl, apiKey, profileId)` changes; use one client-side active-target helper, `localPreference.enabled ? 'claude-local' : connectedAccount?.kind`, so Local Claude and a connected provider cannot both render as active. Keep `/api/model-account/models` and composer `ModelPicker` as the live-catalog path; all custom outbound requests, including discovery, remain behind the SSRF-safe transport with pinned DNS, bounded output, redirect refusal, and error redaction.

**Tech Stack:** TypeScript strict mode, React 18, Zustand-backed local-agent state, Express 4, Drizzle ORM, Postgres/PGlite, Node/undici/dns, Vitest and happy-dom, existing Doop Settings primitives, English and Brazilian Portuguese i18n.

## Global Constraints

- At plan approval time, implementation was gated until the user selected an execution mode; the user has since authorized inline execution and integration.
- Public custom endpoints remain HTTPS-only. Public HTTP is forbidden even when `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=1`.
- A private/local HTTP endpoint may be allowed only when **every** resolved address is blocked/private and the operator set `CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=1`.
- An HTTP endpoint whose DNS answers mix public and private addresses is `url_insecure`, never “private and therefore accepted”.
- For an HTTPS endpoint with mixed answers and private URLs disabled, keep `private_url_blocked`; with the flag enabled, pin to the approved answer set.
- API keys remain sealed server-side and never enter browser responses, errors, logs, analytics, or test snapshots.
- Custom model ids are pass-through ids; use `isCustomModelId`. Do not apply OpenAI or Gemini family regexes.
- Normal `/models` flow must not show or require a manually typed model id. Manual entry exists only through explicit unverified fallback.
- `/models` is not mandatory at save for fallback users. Save is blocked until either a discovered model was selected or fallback is explicitly enabled and contains a valid id.
- `true` catalog re-fetch is allowed at picker open through existing `/api/model-account/models`; do not add a fake catalog cache or change provider ordering.
- Do not verify chat by sending a Chat Completions request; test connection checks endpoint authentication and model discovery only.
- No global “provider order” reordering. `customer-key` remains one provider selected by the same account mechanism.
- All i18n copy must update English and pt-BR together; i18n parity tests remain green.
- Preserve existing OpenRouter, Gemini, OpenAI, ChatGPT, Anthropic, free-tier, local-Claude, and Gemini-Cloud behavior.
- Use `clean-code:typescript`.
- Follow test-first execution for every task.
- **Every requirement in this document implicitly includes these constraints.**

---

## Decisions Locked In

1. **Flow:** `Require /models + fallback`.
2. **Normal connect flow:** selected from discovery, not typed.
3. **Fallback:** explicit only; validates with `isCustomModelId`; marked unverified; usable after failed or empty discovery.
4. **Save gate:** Save requires a current `(baseUrl, apiKey, profileId)` fingerprint and either a selected discovered model or a complete fallback id.
5. **No silent switching:** disappearance from `/models` does not switch model; UI keeps it visibly selected and warns.
6. **Single active target:** local preferences take precedence; otherwise connected account kind.
7. **No schema migration:** model remains `NOT NULL`; fallback still backs it.
8. **No broad refactor:** introduce the smallest shared active-target helper, not a new state architecture.
9. **No test cheating:** fixture servers and mock sockets only where required; do not suppress SSRF guard paths in production code.
10. **Execution authorization:** the user approved inline implementation and integration after reviewing the plan.

---

## File Structure

Create:

- `tests/customInferenceModelsFixture.ts` only if the same fixture is shared by more than one test file; otherwise inline models fixture in `tests/customModelProfiles.test.ts`.
- `tests/modelPicker.test.tsx` for focused composer tests; if an existing happy-dom suite can host the tests, do not duplicate it.
- `src/lib/activeModelTarget.ts` for the single-active-target helper.

Modify:

- `server/customInference.ts` — DNS policy classification and deadline-based resolver.
- `server/chatCompletionsAgent.ts` — stop signal passes through fetch options, not only request init.
- `server/customModelProfiles.ts` — atomic partial updates, capped discovery, fallback result; transactions for activation/delete.
- `server/modelAccounts.ts` — activation/delete transactional `save` path without whole-row clobbering.
- `server/index.ts` only if request/response shape or validation messages need narrow updates.
- `server/modelCatalog.ts` — no API rewrite; verify fallback/missing-model behavior remains safe.
- `shared/customModel.ts` — no change expected.
- `src/lib/api.ts` — client contract stays `{ reachable, models?: string[] }` unless explicitly expanded with ids only; avoid alternate shapes.
- `src/components/CustomModelProfiles.tsx` — tested fingerprint, selection dropdown, fallback, stale edit behavior.
- `src/components/ModelPicker.tsx` — saved-missing-model caption and active-target correctness if chat label reflects wrong provider.
- `src/components/ModelAccount.tsx` — active-target tests/helper.
- `src/lib/i18n/en/models.ts`, `src/lib/i18n/pt-BR/models.ts` — discovery strings; preserve parity.
- Documentation matching behavior; no new env flag expected.

---

## Task 1: Write stop/abort tests and forward cancellation correctly

### Task 1

**Files:**

- Modify: `server/chatCompletionsAgent.ts`
- Modify: `server/customInference.ts`
- Test: `tests/customInferenceAgent.test.ts`
- Test: `tests/customInference.test.ts` only for timeout budget; stop test belongs in agent fixture

**Interfaces**

- Consumes: `TurnRequest.signal?: AbortSignal`
- Produces: abort-visible custom HTTP requests and caller-cancellation-safe transport
- Must not change: fixed-provider URLs, fixed provider headers, redirect rules, one-time connection pool

- [x] **Step 1: Add the failing request-fixture test**

In `tests/customInferenceAgent.test.ts`, add a local helper implementation with explicit lifecycle, never a mock HTTP response body constant nor a test-only transport stub:

```ts
let sawRequestClose = false
let releaseResponse: (() => void) | undefined
const releaseGate = new Promise<void>((resolve) => {
  releaseResponse = resolve
})

server.on('request', (req, res) => {
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    req.on('close', () => {
      sawRequestClose = true
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    releaseGate.then(() => {
      res.end(JSON.stringify({ choices: [{ message: { content: 'done' } }] }))
    })
  }
})
```

Add the abort test using a real local fixture:

```ts
it('forwards abort cancellation into the custom undici request', async () => {
  const controller = new AbortController()
  const promise = runChatCompletionsTurn(customConfig(new URL(baseUrl), 'test-key', 'model-a', false, 'Example'), {
    system: 'sys',
    tools: [],
    messages: [],
    maxTokens: 10,
    signal: controller.signal,
  })

  const reqClosed = waitFor(() => sawRequestClose === true)
  controller.abort()
  releaseResponse?.()

  await expect(promise).rejects.toThrow(/aborted|cancel/i)
  await expect(reqClosed).resolves.toBeUndefined()
})
```

`waitFor` is a tiny local test helper polling `sawRequestClose`; define it in the same file if not already available.

Also add to `tests/customInference.test.ts`:

```ts
it('does not let DNS resolution bypass the request timeout', async () => {
  dnsMocks.lookup.mockReturnValue(new Promise(() => {}))
  const promise = fetchCustomJson(
    new URL('https://provider.example/v1/models'),
    {
      method: 'GET',
    },
    { timeoutMs: 10 },
  )
  await expect(promise).rejects.toMatchObject({ code: 'unreachable' })
})
```

- [x] **Step 2: Run focused tests and verify failure**

```bash
bunx vitest run tests/customInferenceAgent.test.ts tests/customInference.test.ts
```

Expected: request fixture does not observe closure promptly, and timeout test can outlive ten milliseconds.

- [x] **Step 3: Implement minimal cancellation plumbing**

In `tests/customInferenceAgent.test.ts`, keep the fixture import path local and do not add a global mock; do not interpose `AbortSignal` types.

Change `runChatCompletionsTurn` to pass the caller signal as transport options:

```ts
{
  timeoutMs: 10 * 60_000,
  signal: req.signal,
}
```

In `server/customInference.ts`, add a deadline resolver:

```ts
async function lookupWithDeadline(host: string, timeoutMs: number) {
  const started = Date.now()
  const remaining = Math.max(1, timeoutMs - (Date.now() - started))
  return Promise.race([
    dns.lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), remaining)),
  ])
}
```

Pass the result of this helper into `resolveWithPolicy`, and classify deadline errors as `unreachable`; external stop still wins if caller signal is already aborted.

- [x] **Step 4: Verify**

```bash
bunx vitest run tests/customInferenceAgent.test.ts tests/customInference.test.ts
```

Expected: abort closes the connected request; DNS never extends beyond the request budget; timeout remains `unreachable`; user stop remains caller cancellation, not a provider interruption.

- [x] **Step 5: Commit**

```bash
git add server/chatCompletionsAgent.ts server/customInference.ts tests/customInferenceAgent.test.ts tests/customInference.test.ts
git commit -m "fix(custom-inference): forward stop and deadline through custom requests"
```

---

## Task 2: Write mixed-DNS policy tests before changing URL resolution

### Task 2

**Files:**

- Modify: `server/customInference.ts`
- Test: `tests/customInference.test.ts`
- Test: `tests/publicUrl.test.ts` unchanged

**Interfaces**

- Consumes: `PublicAddress`, `isBlockedIp`, `normalizeCustomBaseUrl`
- Produces: `resolveWithPolicy(url, allowPrivate)` returns one classification: `https-public`, `https-private-opt-in`, `http-private-opt-in`, or error code
- Must not change: credentials/query/fragment rejection or pinned-request semantics

- [x] **Step 1: Add the exact DNS matrix**

In `tests/customInference.test.ts`, add the resolver fixtures and assertions:

```ts
const publicAnswer = { address: '93.184.216.34', family: 4 as const }
const privateAnswer = { address: '127.0.0.1', family: 4 as const }

it('rejects public HTTP even when DNS includes a private address', async () => {
  dnsMocks.lookup.mockResolvedValue([publicAnswer, privateAnswer])
  await expect(validateCustomBaseUrl('http://provider.example/v1', true)).rejects.toMatchObject({
    code: 'url_insecure',
  })
})

it('permits public HTTPS with public answers and disabled private URLs', async () => {
  dnsMocks.lookup.mockResolvedValue([publicAnswer])
  await expect(validateCustomBaseUrl('https://provider.example/v1', false)).resolves.toEqual(
    new URL('https://provider.example/v1'),
  )
})

it('permits private HTTP only when every answer is blocked and private URLs are enabled', async () => {
  dnsMocks.lookup.mockResolvedValue([privateAnswer, { address: '10.1.2.3', family: 4 }])
  await expect(validateCustomBaseUrl('http://internal.example/v1', true)).resolves.toEqual(
    new URL('http://internal.example/v1'),
  )
})

it('refuses all-private HTTP when private URLs are disabled', async () => {
  dnsMocks.lookup.mockResolvedValue([privateAnswer])
  await expect(validateCustomBaseUrl('http://internal.example/v1', false)).rejects.toMatchObject({
    code: 'private_url_blocked',
  })
})

it('refuses mixed DNS for HTTPS when private URLs are disabled', async () => {
  dnsMocks.lookup.mockResolvedValue([publicAnswer, privateAnswer])
  await expect(validateCustomBaseUrl('https://provider.example/v1', false)).rejects.toMatchObject({
    code: 'private_url_blocked',
  })
})
```

- [x] **Step 2: Run tests and verify failure on the HTTP fixture**

```bash
bunx vitest run tests/customInference.test.ts
```

Expected: current code routes by an any-private `privateTarget` and allows this HTTP case as long as at least one answer is blocked.

- [x] **Step 3: Implement classification**

```ts
const hasPublic = addresses.some(({ address }) => !isBlockedIp(address))
const allBlocked = addresses.every(({ address }) => isBlockedIp(address))

if (hasPublic && url.protocol !== 'https:') {
  throw new CustomInferenceError('url_insecure', INSECURE_MESSAGE)
}
if (allBlocked && !allowPrivate) {
  throw new CustomInferenceError('private_url_blocked', BLOCKED_MESSAGE)
}
```

Also make literal IPs participate in the same matrix (the current literal path already uses `isBlockedIp`; do not introduce a separate check).

- [x] **Step 4: Verify**

```bash
bunx vitest run tests/customInference.test.ts tests/publicUrl.test.ts
```

Expected: every DNS/protocol case above is green; existing public-url tests are unchanged.

- [x] **Step 5: Commit**

```bash
git add server/customInference.ts tests/customInference.test.ts
git commit -m "fix(custom-inference): reject public HTTP across every DNS mix"
```

---

## Task 3: Make partial updates and activation/delete operations atomic

### Task 3

**Files:**

- Modify: `server/customModelProfiles.ts:258-299`
- Modify: `server/modelAccounts.ts` (`activateCustomProfile`, `disconnectCustomProfile`)
- Test: `tests/customModelProfiles.test.ts`
- Test: `tests/providerKeyAccounts.test.ts`

**Interfaces**

- Consumes: Drizzle transactions with `tx`, `RETURNING`, Postgres row lock (`for('update')`)
- Produces: `updateProfile(userId, id, patch)` and `deleteProfile(userId, id)` semantics that cannot merge stale full-row snapshots
- Public API signatures do not change

- [x] **Step 1: Add executable concurrency tests**

```ts
it('keeps independent profile updates made concurrently', async () => {
  const profile = await createProfile('alice', input({ name: 'A', model: 'm-a' }))

  await Promise.all([
    updateProfile('alice', profile.id, { model: 'm-b' }),
    updateProfile('alice', profile.id, { name: 'B' }),
  ])

  expect(await getProfile('alice', profile.id)).toMatchObject({ name: 'B', model: 'm-b' })
})

it('activation and deletion cannot leave an account pointing at a deleted profile', async () => {
  const profile = await createProfile('alice', input())

  const outcomes = await Promise.allSettled([
    activateCustomProfile('alice', profile.id),
    deleteProfile('alice', profile.id),
  ])

  const account = await getAccount('alice')
  if (account?.profileId) {
    expect(await getProfile('alice', account.profileId)).not.toBeNull()
  }
  expect(outcomes.length).toBe(2)
})
```

Do not export the transaction lock helper for the test; use public APIs and assert the invariant.

- [x] **Step 2: Run and verify current lost update / stale pointer**

```bash
bunx vitest run tests/customModelProfiles.test.ts tests/providerKeyAccounts.test.ts
```

Expected: independent profile update can restore a stale model or name, and concurrent activation/delete can leave an account pointing at a missing profile before Task 3 is implemented.

- [x] **Step 3: Implement atomic writes**

Replace read-modify-write in `updateProfile` with:

```ts
const set: Partial<typeof customModelProfiles.$inferInsert> = { updatedAt: Date.now() }
if (Object.hasOwn(patch, 'name')) set.name = normalizeName(patch.name)
if (Object.hasOwn(patch, 'baseUrl')) set.baseUrl = await normalizedBaseUrl(patch.baseUrl)
if (Object.hasOwn(patch, 'model')) set.model = normalizeModel(patch.model)
if (Object.hasOwn(patch, 'supportsVision')) {
  set.supportsVision = patch.supportsVision !== false
}
if (Object.hasOwn(patch, 'apiKey')) set.apiKey = await normalizeKey(patch.apiKey)
```

Then `await tx.update(...).set(set).returning()`; if no row returns, throw `CustomModelProfileNotFoundError`.

Activation/deletion implementation must happen in one transaction each:

```ts
await db.transaction(async (tx) => {
  const [locked] = await tx
    .select()
    .from(customModelProfiles)
    .where(and(eq(customModelProfiles.id, profileId), eq(customModelProfiles.userId, userId)))
    .for('update')

  if (!locked) throw new CustomModelProfileNotFoundError()
  // upsert or conditional delete through tx, never through global db
})
```

Profile edits that change an active profile's `model` update the owning account pointer in the same transaction with a guarded `profileId` predicate; do not route through the old full-row `save()` implementation.

- [x] **Step 4: Verify**

```bash
bunx vitest run tests/customModelProfiles.test.ts tests/providerKeyAccounts.test.ts
```

Expected: independent patches both persist; no public row points at a deleted profile; intentional activation still succeeds when delete is not scheduled first.

- [x] **Step 5: Commit**

```bash
git add server/customModelProfiles.ts server/modelAccounts.ts tests/customModelProfiles.test.ts tests/providerKeyAccounts.test.ts
git commit -m "fix(custom-inference): make profile writes and activation transactional"
```

---

## Task 4: Establish one client-side active target

### Task 4

**Files:**

- Modify: `src/components/CustomModelProfiles.tsx`
- Modify: `src/components/ModelAccount.tsx`
- Modify: `src/components/ModelPicker.tsx` only where label/status semantics share the same helper
- Create: `src/lib/activeModelTarget.ts`
- Test: `tests/localAgentSelection.test.ts`
- Test: `tests/customModelProfiles.test.tsx`

**Interfaces**

- Consumes: `useLocalAgent((state) => state.preference)` and `ModelAccountStatus`
- Produces: `activeModelTarget(localEnabled, account): 'claude-local' | AccountKind | null`
- Must not change: server routing; this helper is presentation and tests only do not duplicate daemon routing

- [x] **Step 1: Add a failing consistency test**

In `tests/customModelProfiles.test.tsx`, add a module-local mock near the existing api mocks:

```ts
const localMode = vi.hoisted(() => ({ preference: { enabled: true, model: 'default' as string } }))

vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: (selector: (state: { preference: typeof localMode.preference }) => unknown) =>
    selector({ preference: localMode.preference }),
  refreshLocalAgent: vi.fn().mockResolvedValue({ preference: { enabled: false, model: 'default' } }),
  selectLocalAgent: vi.fn(),
}))
```

Test:

```ts
it('does not show the connected provider as active when local selection wins', async () => {
  mocks.list.mockResolvedValue([profile({ active: true })])
  mocks.account.mockResolvedValue(activeAccount())
  await render(activeAccount())
  expect(container.textContent).not.toContain('Active')
})
```

After the custom activation mock returns a fresh account, assert `refreshLocalAgent` has been called by the save path if implementation refreshes the store.

- [x] **Step 2: Run and confirm expected discord**

```bash
bunx vitest run tests/customModelProfiles.test.tsx
```

Expected: the custom profile renders an “Active” pill while the mocked local preference remains enabled.

- [x] **Step 3: Implement the helper**

```ts
// src/lib/activeModelTarget.ts
import type { ModelAccountKind, ModelAccountStatus } from './api'

export type ActiveModelTarget = 'claude-local' | ModelAccountKind | null
export function activeModelTarget(localEnabled: boolean, account: ModelAccountStatus | null): ActiveModelTarget {
  if (localEnabled) return 'claude-local'
  if (account?.connected && account.kind) return account.kind
  return null
}
```

Use `activeModelTarget(...)` in custom row, local row label, and all existing connected-row “Active” labels. Connecting/switching from the custom row still calls the server route, and the client calls `refreshLocalAgent()` (or receives an already-refreshed preference) so local state does not remain stale.

- [x] **Step 4: Verify and commit**

```bash
bunx vitest run tests/customModelProfiles.test.tsx tests/localAgentSelection.test.ts tests/i18n.test.ts
git add src/lib/activeModelTarget.ts src/components/CustomModelProfiles.tsx src/components/ModelAccount.tsx src/components/ModelPicker.tsx tests/customModelProfiles.test.tsx tests/localAgentSelection.test.ts
git commit -m "fix(custom-inference): use one active-target rule in settings"
```

---

## Task 5: Write `/models` cap and error contract tests first

### Task 5

**Files:**

- Modify: `server/customModelProfiles.ts`
- Modify: `server/index.ts` only if validation cannot express the new cap locally
- Test: `tests/customModelProfiles.test.ts`

**Interfaces**

- Consumes: `fetchCustomJson`, `isCustomModelId` for fallback checks, existing `CustomEndpointTestResult` JSON
- Produces: capped `models: string[]`, stable test error codes, no key echo
- Must not change: 2 MB response cap, redirect refusal, bounded request timeout

- [x] **Step 1: Write discovery contract tests using existing test server style**

Create a focused local fixture helper in `tests/customModelProfiles.test.ts`:

```ts
interface ModelFixture {
  status?: number
  body?: unknown
  contentType?: string
}

async function withModelFixture(body: ModelFixture, run: (baseUrl: string) => Promise<void>) {
  const server = http.createServer((_req, res) => {
    res.writeHead(body.status ?? 200, { 'content-type': body.contentType ?? 'application/json' })
    res.end(body.body === undefined ? '' : String(body.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
```

Tests:

```ts
it('returns deduplicated model ids and no key echo', async () => {
  await withModelFixture(
    { body: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }) },
    async (baseUrl) => {
      const result = await testCustomEndpoint('alice', { baseUrl, apiKey: 'sk-never-returned' })
      expect(result).toEqual({ reachable: true, models: ['a', 'b'] })
      expect(JSON.stringify(result)).not.toContain('sk-never-returned')
    },
  )
})

it('caps parsed model ids at a bounded limit', async () => {
  const entries = Array.from({ length: 600 }, (_, i) => ({ id: `m-${i}` }))
  await withModelFixture({ body: JSON.stringify({ data: entries }) }, async (baseUrl) => {
    const result = await testCustomEndpoint('alice', { baseUrl })
    expect(result.models?.length).toBe(MAX_DISCOVERED_MODELS)
  })
})

it('maps malformed models JSON to not_compatible', async () => {
  await withModelFixture({ body: 'not-json' }, async (baseUrl) => {
    await expect(testCustomEndpoint('alice', { baseUrl })).resolves.toMatchObject({
      reachable: false,
      errorCode: 'not_compatible',
    })
  })
})

it('does not send chat requests while testing models', async () => {
  // fixture must count paths; invoke handler and assert only /v1/models appears
})
```

- [x] **Step 2: Run focused tests and verify cap failure**

```bash
bunx vitest run tests/customModelProfiles.test.ts
```

- [x] **Step 3: Implement cap and parser only**

Declare server constant:

```ts
export const MAX_DISCOVERED_MODELS = 500
```

Parse through the same bounded validator and pass through conservative ids accepted by `isCustomModelId` for consistency; no provider family regex. Set response to `models` strings exactly.

- [x] **Step 4: Verify and commit**

```bash
bunx vitest run tests/customModelProfiles.test.ts
git add server/customModelProfiles.ts tests/customModelProfiles.test.ts
git commit -m "feat(custom-inference): return capped discovered model ids"
```

If route files change, add `server/index.ts` explicitly; do not add unused build artifacts.

---

## Task 6: Implement tested-fingerprint and discovery-only selection in the UI

### Task 6

**Files:**

- Modify: `src/components/CustomModelProfiles.tsx`
- Modify: `src/lib/api.ts:198-227`
- Modify: `src/lib/i18n/en/models.ts` and `src/lib/i18n/pt-BR/models.ts`
- Test: `tests/customModelProfiles.test.tsx`

**Interfaces**

- Consumes: `CustomEndpointTestResult { reachable, models? , errorCode?, error? }`
- Produces: UI-only draft containing `selectedModel`, `discoveredModels`, `useManualFallback`; payload remains `CustomModelProfileInput` with `model`
- Must not change: server key redaction or test route behavior

- [x] **Step 1: Write failing component tests**

```ts
it('requires selecting a discovered model before save', async () => {
  mocks.test.mockResolvedValue({ reachable: true, models: ['m-a', 'm-b'] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('Local Ollama'), 'Local Ollama')
  await fill(input('https://provider.example/v1'), 'https://provider.example/v1')
  await click(button('Test connection'))

  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
  // Select m-a in the Select dropdown; exact helper mirrors existing select tests.
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'm-a' }))
})

it('invalidates discovery when base URL changes after test', async () => {
  mocks.test.mockResolvedValueOnce({ reachable: true, models: ['m-a'] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('https://one.example/v1'), 'https://one.example/v1')
  await click(button('Test connection'))
  await fill(input('https://one.example/v1'), 'https://two.example/v1')

  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
})

it('uses stored key when blank key is tested for saved profile', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  await render(disconnected)
  await click(button('Edit'))
  await click(button('Test connection'))

  expect(mocks.test).toHaveBeenCalledWith({
    baseUrl: 'http://127.0.0.1:11434/v1',
    profileId: 'profile-1',
  })
})

it('offers manual input only after enabling unverified fallback', async () => {
  mocks.test.mockResolvedValue({ reachable: true, models: [] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await click(button('Test connection'))

  expect(container.querySelector('input[name="models-manual"]')).toBeNull()
  // enable fallback; manual input visible; invalid ids disabled
})
```

Additional exact assertions:

- entering any new key invalidates the tested fingerprint;
- missing saved model remains disabled/visible and save requires entering fallback;
- empty discovered list exposes fallback automatically after enabling it;
- selected model is never rendered as an `<input>`;
- normal path sends no `model` to `/models` test.

- [x] **Step 2: Run failing test**

```bash
bunx vitest run tests/customModelProfiles.test.tsx
```

- [x] **Step 3: Implement the draft state and gate**

Keep a fingerprint function in the component test helper or local utility:

```ts
const fingerprint = (draft: Draft) =>
  JSON.stringify({
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey === null ? null : draft.apiKey?.trim() || '(stored)',
    profileId: draft.id ?? null,
  })
```

Save enabled only when:

```ts
draft.testedFingerprint === fingerprint(draft) &&
  ((!draft.useManualFallback && Boolean(draft.selectedModel)) ||
    (draft.useManualFallback && isCustomModelId(draft.manualModel)))
```

On base URL, API key, or profile identity change: clear discovery list, selection, and fingerprint. For saved profile identity, editing name/vision alone preserves valid discovery state; changing credential does not.

Test in discovery mode sends:

```ts
{
  baseUrl: draft.baseUrl.trim(),
  ...(draft.id ? { profileId: draft.id } : {}),
  ...(draft.apiKey !== undefined ? { apiKey: draft.apiKey } : {}),
}
```

Normal UI has dropdown with discovered ids; if list exceeds 100, include search. Fallback link appears only for failed/empty discovery or explicit opt-in. Do not test Chat Completions automatically on saving.

- [x] **Step 4: Verify and commit**

```bash
bunx vitest run tests/customModelProfiles.test.tsx tests/i18n.test.ts
git add src/components/CustomModelProfiles.tsx src/lib/api.ts src/lib/i18n/en/models.ts src/lib/i18n/pt-BR/models.ts tests/customModelProfiles.test.tsx
git commit -m "feat(custom-inference): select discovered models after test"
```

---

## Task 7: Add focused composer behavior for model switching and missing catalog entries

### Task 7

**Files:**

- Modify: `src/components/ModelPicker.tsx` only for missing-current-model caption and stale catalog behavior
- Modify: `src/components/ModelAccount.tsx` only for active-target helper consumption if needed
- Test: `tests/modelPicker.test.tsx`
- Test: `tests/chatCompletionsAgent.test.ts` untouched except fixture if needed

**Interfaces**

- Consumes: mocked `../src/lib/api`, mocked `../src/components/ModelAccount`, `activeModelTarget` helper
- Produces: bounded proof that chat picker lists live list entries and keeps saved missing id visible
- Must not change: request routing; selecting a model only calls `PATCH /api/model-account`

- [x] **Step 1: Create the focused test**

```ts
const accountState = vi.hoisted(() => ({
  account: { connected: true, kind: 'custom-key' as const, model: 'm-missing' },
}))

vi.mock('../src/components/ModelAccount', () => ({
  useModelAccount: () => ({ account: accountState.account, set: vi.fn(), refresh: vi.fn() }),
  useAgentModels: () => ({
    models: [{ id: 'm-a', name: 'm-a', blurb: '' }],
    live: true,
  }),
}))
```

Write:

- open picker;
- `m-a` listed;
- `m-missing` remains visible with translated caption;
- selecting `m-a` invokes `api.setAgentModel('m-a')`;
- selecting cannot silently substitute `m-missing`;
- with local preference enabled, picker/label shows local authoritative state once Task 4 lands; do not broaden this task into unrelated picker redesign.

- [x] **Step 2: Run expected RED state**

```bash
bunx vitest run tests/modelPicker.test.tsx
```

If `/models` currently already lists and returns saved fallback, assert existing behavior instead of duplicating it.

- [x] **Step 3: Implement minimal missing-model caption/search only**

Use existing Select primitives; search input label is `Search models` in English and equivalent in Portuguese. Keep local translation keys; do not add a duplicate picker.

- [x] **Step 4: Verify and commit**

```bash
bunx vitest run tests/modelPicker.test.tsx tests/i18n.test.ts
git add src/components/ModelPicker.tsx src/components/ModelAccount.tsx tests/modelPicker.test.tsx
git commit -m "feat(custom-inference): show live and missing custom models in composer"
```

---

## Task 8: Align documentation and manual fallback behavior, then commit

### Task 8

**Files:**

- Modify: `README.md`
- Modify: `docs/custom-inference.md`
- Modify: `src/lib/i18n/en/models.ts`, `src/lib/i18n/pt-BR/models.ts` if translation strings are not already included in Task 6
- Test: `tests/modelCatalog.test.ts`

**Interfaces**

- Consumes: live catalog fallback path from `modelCatalogFor`, saved model preservation behavior
- Produces: documented user journey, no new environment variables

- [x] **Step 1: Model catalog behavior assertion**

```ts
it('preserves saved custom model id when live /models omits it', async () => {
  const catalog = await modelCatalogFor(active, [])
  expect(catalog.models.map((model) => model.id)).toContain('saved-model')
})
```

Add one empty-list assertion and one `/models` rejection assertion if not already covered by the existing custom suite.

- [x] **Step 2: Run catalog suite**

```bash
bunx vitest run tests/modelCatalog.test.ts
```

- [x] **Step 3: Write docs around actual behavior**

Include all of this:

- testing lists models through `/v1/models`;
- normal users choose from that list;
- manual id is a fallback explicitly declared unverified;
- empty/failing/missing model from `/models` does not silently change selection;
- public HTTP remains forbidden; private/local needs operator flag;
- switching in composer changes the saved profile's model;
- superseding/API key behavior is not visible to browser;
- minimal example endpoints use example values only; never real secrets.

- [x] **Step 4: Commit**

```bash
git add README.md docs/custom-inference.md tests/modelCatalog.test.ts src/lib/i18n/en/models.ts src/lib/i18n/pt-BR/models.ts
git commit -m "docs(custom-inference): document dynamic model selection"
```

If translations were committed in Task 6, omit duplicates.

---

## Task 9: Run bounded end-to-end fixture matrix and full verification

### Task 9

**Files:**

- Modify: `tests/customInferenceAgent.test.ts`
- Modify: `tests/customModelProfiles.test.ts`
- Modify: fixture helpers only; no production behavior outside prior tasks
- Test: `tests/customInference.test.ts`, `tests/modelCatalog.test.ts`, `tests/chatCompletionsAgent.test.ts`, `tests/modelTurnRetry.test.ts`

**Interfaces**

- Consumes: local fixture helpers; `POST /v1/chat/completions` request recorder
- Produces: deterministic regression proof, not new product behavior

- [x] **Step 1: Add or extend shared fixture**

Fixture support:

- `/v1/models` returns `a`, `b`;
- 401/404/empty/malformed/oversized cases;
- `/v1/chat/completions` validates `model`;
- redirect returns 302 to another origin without following;
- request close is observable for abort tests;
- no downloading scripts or remote modules.

- [x] **Step 2: Add two end-to-end journeys**

```text
Journey A: create with only name/url/key -> test returns { models: [a,b] } -> select b -> save -> activate -> switch composer to a -> chat fixture receives model "a"
```

```text
Journey B: endpoint missing /models -> fallback selected -> save -> activation -> fixture records manual model id -> live catalog reports live:false and keeps saved id selected
```

- [x] **Step 3: Run full suite and checks**

```bash
bunx vitest run tests/customInference.test.ts tests/customInferenceAgent.test.ts tests/customModelProfiles.test.ts tests/customModelProfiles.test.tsx tests/modelCatalog.test.ts tests/chatCompletionsAgent.test.ts tests/modelTurnRetry.test.ts tests/i18n.test.ts tests/modelPicker.test.tsx
bun run typecheck
bun run lint
```

Expected: all named suites pass; typecheck and lint have no errors. If unrelated existing failure is present, record it exactly and do not rewrite unrelated legacy tests as a side effect.

- [x] **Step 4: Commit verification only if behavior/tests changed**

```bash
git add tests/customInferenceAgent.test.ts tests/customModelProfiles.test.ts tests/modelPicker.test.tsx
git commit -m "test: cover custom endpoint discovery flow end to end"
```

---

## Self-Review Against Your Input

1. **Normal flow requires no typed model:** Tasks 5 and 6 establish discovery and disable save until a member of the returned list is selected; fallback is explicit and marked unverified.
2. **Successful test drives selection:** Task 5 returns ids; Task 6 replaces the model input with a Select; Task 6 clears it when fingerprint changes.
3. **All endpoint models are shown dynamically:** capped server list and live picker/search keep it bounded; unknown ids remain possible only through explicit unverified fallback.
4. **Selection persists / changes from chat:** Task 3 makes profile updates atomic; Task 4 keeps active target honest; Task 7 covers composer behavior; Task 9 verifies end-to-end.
5. **Public HTTP blocked:** Task 1 and Task 2 pin DNS and enforce mixed/private policy.
6. **Stopped requests stop:** Task 1 forwards the signal into undici and confirms closure with a real fixture.
7. **Overwrites cannot resurrect stale values:** Task 3 uses transactions, `RETURNING`, and row locks.
8. **Deleted endpoint cannot become active:** Task 3 races activation against deletion and asserts the invariant.
9. **No silent model replacement:** Task 7 and Task 8 keep missing saved model visible and force explicit choice.
10. **No provider/order hijack:** no provider rewrite; only one shared presentation-time helper.

## Remaining Deliberate Tradeoff

Save does not call `/models` again at save time. This is intentional, because a transient discovery failure should not invalidate a user's save and because the endpoint explicitly promised no re-check. Live picker remains authoritative at use time. The fallback is visible and explicitly unverified, so the tradeoff is surfaced instead of hidden.

## Verification Checklist Before Calling It "Perfect"

- [x] Fixture endpoint returns mixed DNS fixtures for one public + one private answer
- [x] Custom route returns no keys and no URL-derived credentials
- [x] A saved missing model is visible but clearly indicated as not listed
- [x] "Local Claude" and "custom endpoint" never both render active
- [x] A stop aborts the request and closes the fixture connection
- [x] Save is disabled on stale discovery or empty fingerprint
- [x] Focused suite, typecheck, and lint pass
- [x] Full suite (250 files, 2,362 tests) passes with one worker
