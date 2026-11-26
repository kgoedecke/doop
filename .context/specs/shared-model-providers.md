# Shared model providers (instance-wide)

Status: implemented

## Problem

A custom provider (Settings → Doop Agent → Custom provider) is stored per person (`model_accounts`, key
`user_id + kind`). A company that self-hosts Doop next to its own model gateway (LiteLLM, vLLM, Ollama…) has to make
every employee paste the same base URL, key and model list. New people start with no agent at all until they do.
Doop's only instance-wide model knob is the free tier (`DOOP_AGENT_PROVIDER` + `ANTHROPIC_API_KEY`), which offers one
fixed model and no model menu.

## Goal

A Doop **admin** defines one or more **shared custom providers** once. Every signed-in user sees them in the agent and
model pickers next to their personal connections, can pick a model and switch a shared provider off for themselves,
and cannot see the key or edit or remove the provider. New users get a working agent at their first sign-in.

Out of scope: workspace-scoped sharing, sharing built-in kinds (ChatGPT/OpenAI/Anthropic keys), per-user quotas.

## Behaviour

1. **Admin → Instance → "Shared model providers"** lists the shared providers: name, API type, base URL, model count,
   on/off. Admins can add one (the existing `CustomProviderForm`: name, API type, base URL, key, headers, models,
   vision, max output tokens, Test, Fetch models), edit it (the key is never shown; blank keeps it), switch it off, or
   delete it.
2. **Users** see each enabled shared provider as a connection labelled with its name and a "Shared by your admin" badge.
   Model picker, the "use for agent" default and the per-user on/off toggle work as for a personal provider. Edit,
   Remove and the key field are absent.
3. **Precedence:** shared and personal providers coexist (different kinds). The agent default resolution (`agentDefaults`)
   treats a shared provider like any connected account. A user without any personal account therefore defaults to the
   first enabled shared provider, so new users "just work".
4. **Per-user state on a shared provider** (picked model, reasoning effort, on/off) is stored per user. Changing it never
   touches the shared definition or other users.
5. **Admin switches a provider off or deletes it:** it disappears for everyone immediately. Per-user prefs for a deleted
   provider are deleted.
6. **Operator switches:** `DOOP_CUSTOM_PROVIDERS=false` disables shared providers too. `DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS`
   applies to them exactly as to personal ones (same fetch path).
7. **Free-tier meter:** a shared provider counts as "a connected model account" for `RESIDENT_TASK_LIMIT` / allowance
   purposes, like a personal one: the run is on the company's model, not the server's paid key.
   **Image generation** bills it the same way: a person with a shared provider has a connection of their own, so the
   server's image keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`), which cover only people who connected no model account,
   no longer draw for them. Such a person draws with an image-capable account of their own (ChatGPT, OpenAI or Gemini
   key) or with the image models a provider lists, a shared one included
   ([custom-provider-image-models.md](custom-provider-image-models.md)).
8. **Security:**
   - The shared key and headers are sealed at rest like personal ones (`sealedText`). They are read sealed and opened
     per provider: one whose key or headers cannot be unsealed (its encryption key rotated out of
     `SECRETS_ENCRYPTION_KEYS`, the value damaged) is skipped with a warning, for people and in Admin alike, and
     never takes anyone's other connections down with it.
   - They are never returned by any API, including to admins, and never sent anywhere new: the stored key and headers
     go only to the origin they were saved for. An admin probe (`/models`, `/test`) for another origin, or an edit
     that moves the base URL to another origin, has to bring its own key and headers (or say "none", an empty value);
     otherwise it is refused with 400 saying so.
   - Text from the endpoint (an error body, a refusal) has the key and every header value masked
     (`redactSecrets` in `server/customProviderFetch.ts`) before it reaches a person, a log line or a stored run
     error, since an endpoint may quote the credential it refused. This holds for personal providers too.
   - Admin routes are behind `isAdmin`.
   - Users get a read-only view with no `baseUrl` secrets: its origin only, and no header names.
   - The full base URL is shown to admins only (a stored base URL never carries credentials: the validator refuses
     them).
   - The set-up probes (`/api/custom-providers/models|test`) never fall back to a shared provider's stored key, which
     would let a person send it to a URL of their choosing.
9. **Wording:** where a run fails on a shared provider's credential or configuration, the card and status line tell the
   person to ask their admin (Admin → Shared models) rather than to reconnect or edit it. These are server-written
   English strings, like every other run failure; there is no i18n catalog on the server.

## Data

- `shared_model_accounts`:
  - `kind` PK (`custom:<id>`, same id format as personal);
  - `custom` jsonb (`CustomProviderConfig`);
  - `api_key` sealed;
  - `custom_headers` sealed;
  - `enabled` bool;
  - `created_by`, `updated_by`, `created_at`, `updated_at`.
- `shared_model_account_prefs`:
  - `user_id`, `kind` (PK both);
  - `model` text null, `reasoning_effort` text null, `enabled` bool default true;
  - `updated_at`.
- Migration `0066_shared_model_accounts.sql` (next free number on main), idempotent (`IF NOT EXISTS`).

## Code shape

- `server/sharedModelAccounts.ts` holds CRUD for the shared table (reusing `parseCustomProviderConfig` and
  `parseCustomHeaders`) and the prefs read/write.
- `server/modelAccounts.ts`:
  - `getAccounts(userId)` returns personal accounts, then the enabled shared ones merged with the user's prefs, as
    `ModelAccount & { shared: true }`;
  - `getAccount(userId, kind)` resolves shared kinds the same way;
  - `setAccountModel`, `setAccountEffort` and `setAccountEnabled` on a shared kind write prefs;
  - `disconnect` and `updateCustomProvider` on a shared kind are refused (`403 shared provider`).
- `statusOf()` adds `shared: true`. `/api/model-account` returns it; the UI hides edit/remove when it is set.
- `server/admin.ts` gets `GET/POST /api/admin/shared-providers`, `PUT/PATCH/DELETE /api/admin/shared-providers/:kind`
  (`PATCH { enabled }` switches one on or off without resending its description), and
  `POST /api/admin/shared-providers/test|models`, reusing the custom-provider test and model-discovery code. They sit
  behind the admin router's existing guard, which answers a non-admin 404 like every other admin route.
- UI:
  - `src/pages/Admin.tsx` gets a new section that reuses `CustomProviderForm` in "admin" mode;
  - `src/components/ModelAccount.tsx` shows the shared badge and hides the edit and remove actions;
  - i18n keys go into `src/lib/i18n/en/*` and `src/lib/i18n/pt-BR/*`, as every locale carries the same keys.

## Tests

- **Unit:**
  - merge order and prefs;
  - per-user model and enable;
  - refusal to edit or delete a shared kind as a user;
  - a disabled or deleted shared provider disappears;
  - `DOOP_CUSTOM_PROVIDERS=false` hides shared providers;
  - the default agent resolution picks a shared provider for a user with no accounts;
  - image generation does not fall back to the server's image keys for a user with only a shared provider.
- **HTTP:**
  - admin-only guards (a non-admin gets the admin router's 404 on every route);
  - the stored key and headers never go to another origin (admin probes and edits);
  - the key is never in any response;
  - create → user sees it → admin disables → user no longer sees it.
- Existing suites stay green: `bun run typecheck`, `bun run lint`, `bun run test`.

## Notes

- Deleting an account deletes that person's prefs rows (`purgeUserData`); the shared providers stay.
- Two admins editing one shared provider at once: the last write wins, the same as personal providers. A key or headers
  left out of an edit are kept whoever wrote them last.
- A person who never picked a model runs on the provider's first model (`models[0]`), so reordering the list in Admin
  moves them. A pick on a model that is later removed falls back the same way.
- Image descriptions (`server/imageDescriptions.ts`) run on the uploader's default connection, else their first enabled
  account whose (picked) model sees images, before any server describer. A shared provider whose model sees images
  therefore describes uploads for people with nothing of their own, on the company's endpoint.

## Upgrade notes

- Image generation: a person whose only connection is a shared provider is billed as having a connection of their own,
  so the server's image keys no longer draw for them (they did not draw for people with a personal provider either).

- Migration `0066_shared_model_accounts` adds the two tables; it is the next free number on upstream `main` at the time
  of writing and runs on boot like every other. Nothing existing changes.
- The migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). An earlier draft of this
  branch numbered it `0062`; a fork that ran that draft already has both tables, and the renumbered migration runs over
  them without error.
- Such a fork must also delete the draft's row from `drizzle.__drizzle_migrations` before it boots this version
  (`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795420894296`). Drizzle applies only migrations newer
  than the last one it recorded, and that row's timestamp is newer than upstream's `0062`–`0065`, which would
  otherwise be skipped without an error. A fork that already booted this version without doing so deletes the
  `0066` row too (`created_at IN (1795420894296, 1795596622579)`) and boots again: upstream's four then run, and
  `0066` runs again over the existing tables.
- A fork carrying this branch before it merges must rebase it before each upstream sync: if upstream adds its own
  migration with the same number, the branch's migration has to be renumbered (and its snapshot regenerated) on top
  of upstream's.
