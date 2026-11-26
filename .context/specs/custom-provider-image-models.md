# Image models on custom providers

Status: implemented

## Problem

Image generation (`generate_image`, MCP and resident) draws only with the built-in registry (`IMAGE_MODELS` in
`shared/modelMenu.ts`): GPT Image on a ChatGPT subscription or an OpenAI key, Nano Banana on a Gemini key, Seedream on
the server's `ARK_API_KEY`. A team that self-hosts an image model has no way in. The usual setup is an OpenAI
Images-compatible endpoint (`POST {baseUrl}/images/generations` answering `data[0].b64_json`): a LiteLLM gateway in front
of ComfyUI/FLUX, vLLM, LocalAI. `OPENAI_IMAGES_URL` does not help: it is server-wide, takes registry ids only and runs on
the server's or a person's OpenAI key, and since shared providers the server key no longer draws for people who have one.

## Goal

A custom provider, a person's own or an admin's shared one ([shared-model-providers.md](shared-model-providers.md)),
lists **image models** next to its chat models. Whoever has that provider connected and on finds them in Settings →
Doop Agent → Image model, and `generate_image` draws with the one they picked through the provider's endpoint, on the
provider's key and headers.

Out of scope: image models on an Anthropic-compatible provider (that API has no images endpoint), image editing or
reference images, a Test button for image models, `DOOP_IMAGE_MODEL` naming a custom image model.

## Behaviour

1. **Config.** A Chat Completions provider's description (`CustomProviderConfig`) gets an optional
   `imageModels: { id, name?, transparent? }[]`. `transparent` says the endpoint honours `background: "transparent"`.
   An id can also be a chat model of the same provider. The list is optional: a description stored before it existed stays valid and is
   stored without the field when the list is empty.
2. **Form.** `CustomProviderForm` (Settings and Admin → Shared models) has an "Image models" section under the models,
   for the Chat Completions API type only: id, optional name, a Transparent switch, remove, "Add image model". The ids
   "Fetch models" found are offered for both lists, each list offering the ids it does not hold yet.
3. **Picker.** `GET /api/image-model` lists the registry entries as before, then one entry per image model of each
   custom provider the person has connected and on (their own first, then shared ones), with
   `custom: { provider, name, shared?, transparent? }`. `ImageModelCard` shows them as one row per provider ("Name
   (shared)" for a shared one) with a dropdown when it lists several. The pick is stored in `image_prefs.model` as
   `custom:<id>/<model id>` (`customImageModelRef` in `shared/customProvider.ts`); `PUT /api/image-model` accepts only an
   id the person's picker lists.
4. **Default.** With no pick, the person's own credentials come first: `DOOP_IMAGE_MODEL` when it runs on an account
   of theirs, else the first registry entry that does, else the first custom image model; only then what a server key
   pays for (`DOOP_IMAGE_MODEL` first): any entry for someone who connected nothing, and Seedream on `ARK_API_KEY` for
   everyone. Someone whose only connection is a shared provider with image models therefore draws on it from their
   first sign-in, even where the operator set `ARK_API_KEY`. An explicit pick on Seedream still draws Seedream.
5. **Request.** `POST {baseUrl}/images/generations` through `customProviderFetch` (so `DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS`,
   DNS pinning, no redirects and the 32 MB cap apply), with the provider's headers and `Authorization: Bearer <key>` when
   it has one, and the body `imageApiGenerator` sends to OpenAI: `model`, `prompt`, `n: 1`, `size` from `SIZES`,
   `quality`, `output_format: "png"`, plus `background: "transparent"` when the call asked for a cut-out and the model
   says it can draw one.
6. **Response.** `data[0].b64_json` is decoded. A `data[0].url` (absolute or relative to the base URL) is fetched through
   `customProviderFetch` too, with the provider's key and headers only when it is on the base URL's origin. The result must
   decode as PNG, JPEG or WebP, or the call fails saying so; neither field fails with the endpoint's own `error.message`
   when it gave one.
7. **Transparent.** `generate_image` (MCP and resident) takes an optional `transparent` boolean. Only a custom image
   model marked `transparent` is sent the field; every other model draws opaque. The result says what was drawn, read
   off the image (an alpha channel that is not opaque everywhere), not off the flag: `transparent` in the MCP result, a
   note in the resident's. The stored WebP keeps the alpha; the preview is flattened on white.
8. **Billing.** A custom image model is the person's own connection, a shared provider included (the company's endpoint
   pays). `billed_to` is the provider's name; analytics get `custom-personal` or `custom-shared` instead of the name.
9. **No fallback.** A pick on a custom image model that cannot run now (its provider switched off by the person, switched
   off or deleted by its admin, removed, the model taken off the list, or `DOOP_CUSTOM_PROVIDERS=false`) refuses with the
   fix ("switch it on, or pick another image model"); it never draws on another model, connection or a server key. When
   nothing at all can draw, the refusal names a switched-off provider with image models like a switched-off image account.
   Disconnecting a personal provider deletes its person's pick on it, and deleting a shared provider deletes everyone's
   (`image_prefs` rows starting `custom:<id>/`, in the same transaction), so they fall back to the default rather than
   being refused for a provider that is gone.
10. **Errors.** A 401/403 from a shared provider tells the person to ask their admin (Admin → Shared models), as a run
    failure does; from a personal one, to update the key in Settings. A 404 or "no such model" names the model and the
    missing `/images/generations`. Other failures carry the endpoint's status and text, like the registry providers',
    with the provider's key and every header value masked (`redactSecrets`, as for its chat turns) on the whole text, before
    it is shortened: an endpoint may quote
    the key it refused, and a shared provider's key must never reach a person or a log.
11. **Security.** The key and headers never appear in any response; image models are part of the description, so a
    person's view of a shared provider lists them (they name models, not secrets). Only an admin changes a shared
    provider's image models (the admin routes; `PUT /api/custom-providers/:kind` on a shared kind is 403).

## Data

No migration: `imageModels` rides in the existing `custom` jsonb of `model_accounts` (0051) and
`shared_model_accounts` (0062), re-checked by `parseCustomProviderConfig` on every read, and the pick in the existing
`image_prefs.model` text column.

## Code shape

- `shared/customProvider.ts`: `CustomImageModel`, `MAX_CUSTOM_IMAGE_MODELS` (20), the parser, `customImageModelRef` /
  `parseCustomImageModelRef`.
- `server/imagePrefs.ts` accepts a well-formed custom ref; whether it can run is decided per run.
- `server/imageGen.ts`: `customImageChoices(accounts)`, `customImageGenerator` (the request, link fetch, format check,
  error wording), `chosenImageModel` returning a registry option, a custom choice or the missing custom pick,
  `imageModelAvailability` listing the custom entries, `TRANSPARENT_NOTE` for both tool schemas.
- `server/modelAccounts.ts` `statusOf` passes a shared provider's image models to the person's view.
- UI: `CustomProviderForm.tsx`, `ImageModelCard.tsx`, the image-model count on the Admin row
  (`SharedProviderSettings.tsx`); strings in `src/lib/i18n/{en,pt-BR}/models.ts` and `admin.ts`.

## Tests

- `customProvider.test.ts`: parsing (normalising, the cap, ids, duplicates, names, Anthropic drops them, stored configs
  without the field), the preference ref.
- `customProviderImages.test.ts`: the request (URL, key, headers, body, transparent or not, keyless), personal and shared
  draws, the default for someone with only a shared provider while server keys (`ARK_API_KEY` included) are set, the
  picker's entries, switched-off / deleted / delisted picks refusing without touching the network, link responses with
  and without credentials, non-image and empty answers, error wording, masked secrets (400, 429, an error beside a 200,
  404), transparency read off the image, private hosts.
- `sharedModelAccounts.test.ts`: a shared provider's image models through the real `getAccounts`, and gone with
  `DOOP_CUSTOM_PROVIDERS=false`.
- `customProviderImagesHttp.test.ts` (real server, stub endpoint): admin adds image models, a person cannot change them,
  the picker lists and picks them, MCP `generate_image` stores the image drawn on the shared key, the 401 wording,
  switched off draws nothing, a personal provider's image models, picks deleted with a disconnected or deleted
  provider, no key in any response.
- `customProviderForm.test.tsx`, `imageModelCard.test.tsx`: the form section and the picker rows.

## Notes

- `quality` and `output_format` are OpenAI's GPT Image fields; a strict server that refuses unknown fields will refuse
  them. LiteLLM and most gateways pass or drop them. A per-model "plain request" switch is a follow-up if one turns up.
- A provider still needs at least one chat model, and its image models are offered only while it is on, so it is also a
  chat connection. An endpoint that only draws images (no chat model to list) is not supported on its own; a gateway
  that serves both, the usual setup, is. Image-only providers would need the config, the agent default and the composer
  to skip a provider without chat models, which is a separate change.
