import { env } from './env.ts'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { getAccounts, withFreshToken } from './modelAccounts.ts'
import type { ModelAccount } from './modelAccounts.ts'
import { getImagePref } from './imagePrefs.ts'
import { ACCOUNT_KIND_LABELS, IMAGE_MODELS } from '../shared/modelMenu.ts'
import type { AccountKindName, ImageModelOption } from '../shared/modelMenu.ts'
import {
  CHATGPT_URL,
  DEFAULT_OPENAI_MODEL,
  ModelAuthError,
  modelFor,
  OPENAI_URL,
  ORIGINATOR,
  readEventStream,
  responseError,
} from './openaiAgent.ts'

/**
 * AI image generation for design agents (the generate_image tool, MCP and
 * resident). Powers the same "make me a hero illustration" moment Paper's
 * paper-gen:// URLs do, but as a tool call that returns a stored asset.
 *
 * There is no image model of our own: the user picks one from the shared
 * IMAGE_MODELS registry in Settings (else the server default), and each
 * entry's provider names the credentials that can run it:
 *
 *  - `openai` (GPT Image) rides the Responses API's hosted `image_generation`
 *    tool — a connected ChatGPT subscription through the Codex backend or an
 *    OpenAI key, else the server's OPENAI_API_KEY. The Codex backend ignores
 *    the tool's `model` (ChatGPT picks), so the subscription has no choice;
 *  - `openai-api` (the GPT Image API row: 2.6, 2.5, chatgpt-image-latest, 1.5, 1 Mini) calls OpenAI's Image API
 *    (`/v1/images/generations`) on an OpenAI key only — the user's, else the
 *    server's — where those models are documented and the model id is
 *    honoured;
 *  - `gemini` (Nano Banana) calls generateContent with image output — a
 *    connected Gemini key, else the server's GEMINI_API_KEY;
 *  - `ark` (Seedream, BytePlus ModelArk) — server-only via ARK_API_KEY; there
 *    is no ByteDance BYO account.
 *
 * Whoever pays for the agent run pays for its images; nobody's subscription
 * ever draws for someone else, and an unavailable choice refuses with the fix
 * rather than quietly billing a different key.
 *
 * The Codex path is Codex's current app behaviour, not a published contract:
 * keep every request detail in this one module so a change upstream is a
 * local fix.
 */

/* the registry entry used when a user never picked one */
const DEFAULT_IMAGE_MODEL = env.DOOP_IMAGE_MODEL
/* the text model that fronts OpenAI's hosted tool; unset = the account's own tier */
const ROUTER_MODEL = env.DOOP_IMAGE_ROUTER_MODEL
const FETCH_TIMEOUT_MS = 5 * 60 * 1000
const PREVIEW_PX = 512

export const IMAGE_ASPECTS = ['square', 'landscape', 'portrait'] as const
export type ImageAspect = (typeof IMAGE_ASPECTS)[number]
export const IMAGE_QUALITIES = ['low', 'medium', 'high'] as const
export type ImageQuality = (typeof IMAGE_QUALITIES)[number]

/* the sizes gpt-image accepts; one dimension is always 1024 */
const SIZES: Record<ImageAspect, string> = {
  square: '1024x1024',
  landscape: '1536x1024',
  portrait: '1024x1536',
}

export interface ImageRequest {
  prompt: string
  aspect?: ImageAspect
  quality?: ImageQuality
}

export interface GeneratedImage {
  /** the finished image, recompressed to webp for the frame */
  buf: Buffer
  mime: 'image/webp'
  width: number
  height: number
  /** a small preview the agent can look at without paying for the full image */
  preview: { data: string; mime: 'image/jpeg' }
  /** who paid: "ChatGPT", "OpenAI", "Gemini", or "server" */
  billedTo: string
}

/** Something that can generate an image for a given payer, or the reason it cannot. */
export type Generator =
  | {
      ok: true
      label: string
      /** set on server-key generators: the env var to blame when auth fails */
      authHint?: string
      run: (req: ImageRequest) => Promise<Buffer>
    }
  | { ok: false; reason: string }

export function serverImageGenEnabled(): boolean {
  return Boolean(env.OPENAI_API_KEY || env.GEMINI_API_KEY || env.ARK_API_KEY)
}

/* ---------------------------------------------------------------- */
/* the Responses request                                            */
/* ---------------------------------------------------------------- */

const INSTRUCTIONS =
  'You are an image generation service. Call the image_generation tool exactly once with the user prompt as given; do not rewrite, expand, soften or discuss it. Pass the required size through unchanged — the caller sized it for a specific slot in a design. Reply with nothing else.'

/* gpt-image-2 on this path refuses `background: transparent` ("not supported
   for this model"), so cut-outs are not offered: a design places the image in
   a box or masks it with CSS. */
function requestBody(routerModel: string, imageModel: string, req: ImageRequest) {
  const size = SIZES[req.aspect ?? 'square']
  /* the fronting model chooses the tool's arguments itself and will pick a
     square for a mascot however the tool is configured, so the size is stated
     in the prompt as well as on the tool */
  const text = `${req.prompt}\n\nRequired size: ${size}`
  return {
    model: routerModel,
    instructions: INSTRUCTIONS,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    tools: [
      {
        type: 'image_generation',
        model: imageModel,
        size,
        quality: req.quality ?? 'medium',
        output_format: 'png',
      },
    ],
    tool_choice: { type: 'image_generation' },
    store: false,
    stream: true,
  }
}

async function generateViaResponses(url: string, headers: Record<string, string>, label: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw await responseError(res, label)
  const response = await readEventStream(res)
  const call = (response.output ?? []).find((item) => item.type === 'image_generation_call')
  if (!call) {
    /* the router answered in prose instead of drawing — typically a policy
       refusal, and the text says why */
    const text = (response.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text || part.refusal || '')
      .join(' ')
      .trim()
    throw new Error(text ? `${label} did not generate an image: ${text.slice(0, 300)}` : `${label} returned no image`)
  }
  if (!call.result) throw new Error(`${label} image generation ended with status "${call.status ?? 'unknown'}"`)
  return Buffer.from(call.result, 'base64')
}

function chatgptGenerator(account: ModelAccount, imageModel: string): Generator {
  return {
    ok: true,
    label: 'ChatGPT',
    run: async (req) => {
      const live = await withFreshToken(account)
      return generateViaResponses(
        CHATGPT_URL,
        {
          Authorization: `Bearer ${live.accessToken}`,
          'OpenAI-Beta': 'responses=experimental',
          originator: ORIGINATOR,
          session_id: randomUUID(),
          ...(live.accountId ? { 'chatgpt-account-id': live.accountId } : {}),
        },
        'ChatGPT',
        requestBody(ROUTER_MODEL || modelFor(live), imageModel, req),
      )
    },
  }
}

function apiKeyGenerator(apiKey: string, label: string, routerModel: string, imageModel: string): Generator {
  return {
    ok: true,
    label,
    ...(label === 'server' ? { authHint: 'OPENAI_API_KEY' } : {}),
    run: (req) =>
      generateViaResponses(
        OPENAI_URL,
        { Authorization: `Bearer ${apiKey}` },
        label,
        requestBody(routerModel, imageModel, req),
      ),
  }
}

/* ---------------------------------------------------------------- */
/* OpenAI's Image API: the GPT Image models an API key can choose   */
/* ---------------------------------------------------------------- */

const OPENAI_IMAGES_URL = env.OPENAI_IMAGES_URL

interface OpenAiImageResponse {
  data?: { b64_json?: string }[]
}

/* No text model fronts this call, so the prompt reaches the image model as
   written and the size is the request's own field. */
function imageApiGenerator(apiKey: string, label: string, model: string): Generator {
  /* the server's key is billed as "server" but the error names the provider */
  const provider = 'OpenAI'
  return {
    ok: true,
    label,
    ...(label === 'server' ? { authHint: 'OPENAI_API_KEY' } : {}),
    run: async (req) => {
      const res = await fetch(OPENAI_IMAGES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          prompt: req.prompt,
          n: 1,
          size: SIZES[req.aspect ?? 'square'],
          quality: req.quality ?? 'medium',
          output_format: 'png',
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw await responseError(res, provider)
      const body = (await res.json()) as OpenAiImageResponse
      const b64 = body.data?.[0]?.b64_json
      if (!b64) throw new Error(`${provider} returned no image`)
      return Buffer.from(b64, 'base64')
    },
  }
}

/* ---------------------------------------------------------------- */
/* Gemini (Nano Banana): generateContent with image output          */
/* ---------------------------------------------------------------- */

const GEMINI_MODELS_URL = env.GEMINI_MODELS_URL

const GEMINI_ASPECTS: Record<ImageAspect, string> = {
  square: '1:1',
  landscape: '3:2',
  portrait: '2:3',
}

interface GeminiImageResponse {
  candidates?: { content?: { parts?: { text?: string; inlineData?: { data?: string } }[] } }[]
}

function geminiGenerator(apiKey: string, label: string, model: string): Generator {
  return {
    ok: true,
    label,
    ...(label === 'server' ? { authHint: 'GEMINI_API_KEY' } : {}),
    run: async (req) => {
      const res = await fetch(`${GEMINI_MODELS_URL}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: GEMINI_ASPECTS[req.aspect ?? 'square'] },
          },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        const err = await responseError(res, 'Gemini')
        /* Gemini reports a bad key as a 400, which responseError reads as
           generic — rewrite it to the auth class so the fix is "reconnect" */
        if (/api key not valid/i.test(err.message))
          throw new ModelAuthError('Gemini rejected the API key', { cause: err })
        throw err
      }
      const body = (await res.json()) as GeminiImageResponse
      const parts = body.candidates?.[0]?.content?.parts ?? []
      const inline = parts.find((part) => part.inlineData?.data)?.inlineData?.data
      if (!inline) {
        /* the model answered in prose instead of drawing — typically a policy
           refusal, and the text says why */
        const text = parts
          .map((part) => part.text || '')
          .join(' ')
          .trim()
        throw new Error(text ? `Gemini did not generate an image: ${text.slice(0, 300)}` : 'Gemini returned no image')
      }
      return Buffer.from(inline, 'base64')
    },
  }
}

/* ---------------------------------------------------------------- */
/* Seedream (BytePlus ModelArk): OpenAI-flavoured images endpoint   */
/* ---------------------------------------------------------------- */

const ARK_IMAGES_URL = env.ARK_IMAGES_URL

/* Seedream takes explicit pixel sizes; these mirror the 1:1 / 3:2 / 2:3
   aspects at a resolution comfortably inside its supported range */
const ARK_SIZES: Record<ImageAspect, string> = {
  square: '2048x2048',
  landscape: '2304x1536',
  portrait: '1536x2304',
}

interface ArkImageResponse {
  error?: { message?: string }
  data?: { b64_json?: string; url?: string }[]
}

function arkGenerator(apiKey: string, label: string, model: string): Generator {
  return {
    ok: true,
    label,
    ...(label === 'server' ? { authHint: 'ARK_API_KEY' } : {}),
    run: async (req) => {
      const res = await fetch(ARK_IMAGES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          prompt: req.prompt,
          size: ARK_SIZES[req.aspect ?? 'square'],
          response_format: 'b64_json',
          watermark: false,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw await responseError(res, 'Seedream')
      const body = (await res.json()) as ArkImageResponse
      const image = body.data?.[0]
      if (image?.b64_json) return Buffer.from(image.b64_json, 'base64')
      if (image?.url) {
        /* some Ark deployments only return URLs — fetch through the SSRF
           guard rather than trusting the host blindly */
        const { fetchRemote } = await import('./assets.ts')
        return fetchRemote(image.url)
      }
      const detail = body.error?.message
      throw new Error(
        detail ? `Seedream did not generate an image: ${detail.slice(0, 300)}` : 'Seedream returned no image',
      )
    },
  }
}

/* ---------------------------------------------------------------- */
/* which model, on whose credentials                                */
/* ---------------------------------------------------------------- */

/* A connected account pays for its own provider's models and nothing else:
   the server keys only ever cover users who connected nothing — with one
   deliberate exception, Seedream, which has no BYO path at all, so setting
   ARK_API_KEY is the operator opting into paying for it. Credentials come
   from the accounts switched on; whether the server may pay depends on every
   connected account, so switching them all off never moves the charge onto
   the server. The ChatGPT subscription is preferred over an OpenAI key when
   both are on, since it costs the person nothing extra. */
interface PayerAccounts {
  /** every account connected, on or off */
  all: readonly ModelAccount[]
  /** switched on: the credentials a run may use */
  on: readonly ModelAccount[]
  /** connected anything at all, on or off: no server key pays for them */
  own: boolean
}
const NO_ACCOUNTS: PayerAccounts = { all: [], on: [], own: false }

/** Said to the agent once nothing can draw, in the generate_image descriptions
 *  too, so it stops retrying a call that cannot succeed. */
const DRAW_INSTEAD =
  'Retrying fails the same way until the person connects one; meanwhile use search_images for photography or draw the visual as inline SVG/CSS.'

/** What every generate_image description says up front: who can draw. */
export const IMAGE_PROVIDER_NOTE =
  'It needs an image provider: the person’s ChatGPT subscription, OpenAI API key or Gemini API key, connected and switched on in Settings → Doop Agent (a Claude, OpenRouter, DeepSeek or Kimi connection cannot draw images), or the server’s own image key for someone who has connected no model account. Without one it fails at once saying what to connect: do not retry, use search_images or draw the visual as inline SVG/CSS.'

/* the accounts that can pay for some image model */
const IMAGE_ACCOUNT_KINDS: readonly string[] = ['chatgpt', 'openai-key', 'gemini-key']

function accountName(account: ModelAccount): string {
  return account.custom?.name ?? ACCOUNT_KIND_LABELS[account.kind as AccountKindName] ?? account.kind
}

function listed(names: readonly string[]): string {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** Why no image model at all can run for this payer, and what the person can do about it. */
function noImageProviderReason(accounts: PayerAccounts): string {
  const connect = 'connect a ChatGPT subscription, an OpenAI API key or a Gemini API key in Settings → Doop Agent'
  const switchedOff = accounts.all.filter((account) => !account.enabled && IMAGE_ACCOUNT_KINDS.includes(account.kind))
  if (switchedOff.length > 0) {
    return `image generation is not available: the person’s ${listed(switchedOff.map(accountName))} connection is switched off. Switch it on in Settings → Doop Agent, or ${connect}. ${DRAW_INSTEAD}`
  }
  if (accounts.own) {
    const names = listed([...new Set(accounts.all.map(accountName))])
    return `image generation is not available: ${connect}. The person’s ${names} connection cannot draw images, and this server’s own image keys only cover people who have connected no model account. ${DRAW_INSTEAD}`
  }
  return `image generation is not available: ${connect} (this server’s operator has not set OPENAI_API_KEY, GEMINI_API_KEY or ARK_API_KEY). ${DRAW_INSTEAD}`
}

function openAiAccount(accounts: readonly ModelAccount[]): ModelAccount | undefined {
  return accounts.find((account) => account.kind === 'chatgpt') ?? openAiKeyAccount(accounts)
}

function openAiKeyAccount(accounts: readonly ModelAccount[]): ModelAccount | undefined {
  return accounts.find((account) => account.kind === 'openai-key' && Boolean(account.apiKey))
}

function geminiAccount(accounts: readonly ModelAccount[]): ModelAccount | undefined {
  return accounts.find((account) => account.kind === 'gemini-key' && Boolean(account.apiKey))
}

function available(option: ImageModelOption, accounts: PayerAccounts): boolean {
  switch (option.provider) {
    case 'openai':
      if (accounts.own) return Boolean(openAiAccount(accounts.on))
      return Boolean(env.OPENAI_API_KEY)
    case 'openai-api':
      if (accounts.own) return Boolean(openAiKeyAccount(accounts.on))
      return Boolean(env.OPENAI_API_KEY)
    case 'gemini':
      if (accounts.own) return Boolean(geminiAccount(accounts.on))
      return Boolean(env.GEMINI_API_KEY)
    case 'ark':
      return Boolean(env.ARK_API_KEY)
  }
}

/** The registry entries this payer could actually run, for the Settings UI. */
export async function imageModelAvailability(
  payerId?: string,
): Promise<{ id: string; available: boolean; selected: boolean }[]> {
  const accounts = payerId ? await payerAccounts(payerId).catch(() => NO_ACCOUNTS) : NO_ACCOUNTS
  const chosen = await chosenImageModel(payerId, accounts)
  return IMAGE_MODELS.map((option) => ({
    id: option.id,
    available: available(option, accounts),
    selected: chosen?.id === option.id,
  }))
}

let warnedDefault = false

async function payerAccounts(payerId: string): Promise<PayerAccounts> {
  const all = await getAccounts(payerId)
  return { all, on: all.filter((account) => account.enabled), own: all.length > 0 }
}

/** The model a run will draw with: the user's pick, else the server default,
 *  else the first entry their credentials can run. */
async function chosenImageModel(
  payerId: string | undefined,
  accounts: PayerAccounts,
): Promise<ImageModelOption | null> {
  const pref = payerId ? await getImagePref(payerId) : undefined
  if (pref) {
    const option = IMAGE_MODELS.find((entry) => entry.id === pref)
    if (option) return option
  }
  const fallback = IMAGE_MODELS.find((entry) => entry.id === DEFAULT_IMAGE_MODEL)
  if (!fallback && !warnedDefault) {
    warnedDefault = true
    console.warn(
      `[image-gen] DOOP_IMAGE_MODEL="${DEFAULT_IMAGE_MODEL}" is not on the image-model registry — ignoring it`,
    )
  }
  if (fallback && available(fallback, accounts)) return fallback
  return IMAGE_MODELS.find((entry) => available(entry, accounts)) ?? fallback ?? null
}

function providerGenerator(option: ImageModelOption, accounts: PayerAccounts): Generator {
  /* a server key covers only someone with no account of their own, on or off */
  const { own } = accounts
  switch (option.provider) {
    case 'openai': {
      const account = openAiAccount(accounts.on)
      if (account?.kind === 'chatgpt') return chatgptGenerator(account, option.id)
      if (account?.kind === 'openai-key' && account.apiKey) {
        return apiKeyGenerator(account.apiKey, 'OpenAI', ROUTER_MODEL || modelFor(account), option.id)
      }
      const serverKey = own ? undefined : env.OPENAI_API_KEY
      if (serverKey) return apiKeyGenerator(serverKey, 'server', ROUTER_MODEL || DEFAULT_OPENAI_MODEL, option.id)
      return {
        ok: false,
        reason: `${option.name} is not available: connect a ChatGPT subscription or OpenAI API key in Settings, or pick another image model there. Meanwhile draw the visual as inline SVG/CSS or use search_images.`,
      }
    }
    case 'openai-api': {
      /* a ChatGPT subscription cannot run these: its backend ignores the model id */
      const account = openAiKeyAccount(accounts.on)
      if (account?.apiKey) return imageApiGenerator(account.apiKey, 'OpenAI', option.id)
      const serverKey = own ? undefined : env.OPENAI_API_KEY
      if (serverKey) return imageApiGenerator(serverKey, 'server', option.id)
      return {
        ok: false,
        reason: `${option.name} needs an OpenAI API key (a ChatGPT subscription cannot choose its image model): connect one in Settings, or pick another image model there. Meanwhile draw the visual as inline SVG/CSS or use search_images.`,
      }
    }
    case 'gemini': {
      const account = geminiAccount(accounts.on)
      if (account?.apiKey) return geminiGenerator(account.apiKey, 'Gemini', option.id)
      const serverKey = own ? undefined : env.GEMINI_API_KEY
      if (serverKey) return geminiGenerator(serverKey, 'server', option.id)
      return {
        ok: false,
        reason: `${option.name} is not available: connect a Gemini API key in Settings, or pick another image model there. Meanwhile draw the visual as inline SVG/CSS or use search_images.`,
      }
    }
    case 'ark': {
      const serverKey = env.ARK_API_KEY
      if (serverKey) return arkGenerator(serverKey, 'server', option.id)
      return {
        ok: false,
        reason: `${option.name} is not available on this server (its operator has not set ARK_API_KEY) — pick another image model in Settings. Meanwhile draw the visual as inline SVG/CSS or use search_images.`,
      }
    }
  }
}

/**
 * The generator for one payer: the image model they picked (else the server
 * default), on their own credentials first, else the matching server key.
 * An explicit pick that cannot run refuses with the fix — it never quietly
 * swaps in a different model or bills a key the user did not choose. When no
 * model at all can run, the refusal names what to connect instead.
 */
export async function generatorFor(payerId?: string): Promise<Generator> {
  /* a lookup failure must not read as "no account": that would quietly move
     the charge from the user's own account onto the server key */
  const accounts = payerId
    ? await payerAccounts(payerId).catch((err) => {
        console.error('[image-gen] could not read the connected model accounts', err)
        throw new Error('could not read your connected model accounts — try again in a moment')
      })
    : NO_ACCOUNTS
  /* nothing at all can draw: say what the person can connect, not why the
     default model in particular cannot run (they never picked it) */
  if (!IMAGE_MODELS.some((entry) => available(entry, accounts))) {
    return { ok: false, reason: noImageProviderReason(accounts) }
  }
  const option = await chosenImageModel(payerId, accounts)
  if (!option) return { ok: false, reason: noImageProviderReason(accounts) }
  return providerGenerator(option, accounts)
}

/* ---------------------------------------------------------------- */
/* the finished image                                               */
/* ---------------------------------------------------------------- */

/** Recompress the model's png (large) into what a frame should load, and
 *  cut a preview the agent can judge it by. */
async function finish(png: Buffer, billedTo: string): Promise<GeneratedImage> {
  const image = sharp(png)
  const meta = await image.metadata()
  const preview = await sharp(png)
    .resize({ width: PREVIEW_PX, height: PREVIEW_PX, fit: 'inside' })
    .jpeg({ quality: 70 })
    .toBuffer()
  return {
    buf: await image.webp({ quality: 88 }).toBuffer(),
    mime: 'image/webp',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    preview: { data: preview.toString('base64'), mime: 'image/jpeg' },
    billedTo,
  }
}

const MAX_PROMPT_CHARS = 4000

/** Generate one image for a payer. Throws with a message the agent can act on. */
export async function generateImage(payerId: string | undefined, req: ImageRequest): Promise<GeneratedImage> {
  const prompt = req.prompt.trim()
  if (!prompt) throw new Error('prompt must be a non-empty string')
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt is too long (max ${MAX_PROMPT_CHARS} characters)`)
  const generator = await generatorFor(payerId)
  if (!generator.ok) throw new Error(generator.reason)
  try {
    const png = await generator.run({ ...req, prompt })
    return finish(png, generator.label)
  } catch (err) {
    if (err instanceof ModelAuthError && generator.authHint) {
      /* these are the SERVER's credentials — "reconnect your account" would
         send users chasing a connection they don't have */
      throw new Error(`the image provider rejected this server’s ${generator.authHint}`, { cause: err })
    }
    throw err
  }
}

/* exported for tests */
export const _internal = { requestBody, SIZES, ARK_SIZES, GEMINI_ASPECTS, chosenImageModel }
