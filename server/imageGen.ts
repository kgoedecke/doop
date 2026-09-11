import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { getAccount, withFreshToken } from './modelAccounts.ts'
import type { ModelAccount } from './modelAccounts.ts'
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
 * There is no image model of our own: generation rides the Responses API's
 * hosted `image_generation` tool, which both of a user's connectable accounts
 * reach — a ChatGPT subscription through the Codex backend (the same request
 * the Codex CLI's $imagegen skill makes, billed to the subscription) and a
 * plain OpenAI API key against api.openai.com. A server key (OPENAI_API_KEY)
 * covers users who connected nothing. Whoever pays for the agent run pays for
 * its images; nobody's subscription ever draws for someone else.
 *
 * The Codex path is Codex's current app behaviour, not a published contract:
 * keep every request detail in this one module so a change upstream is a
 * local fix.
 */

const IMAGE_MODEL = process.env.DOOP_IMAGE_MODEL || 'gpt-image-2'
/* the text model that fronts the hosted tool; unset = the account's own tier */
const ROUTER_MODEL = process.env.DOOP_IMAGE_ROUTER_MODEL || ''
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
  /** who paid: "ChatGPT", "OpenAI", or "server" */
  billedTo: string
}

/** Something that can generate an image for a given payer, or the reason it cannot. */
export type Generator =
  { ok: true; label: string; run: (req: ImageRequest) => Promise<Buffer> } | { ok: false; reason: string }

export function serverImageGenEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

/* ---------------------------------------------------------------- */
/* the Responses request                                            */
/* ---------------------------------------------------------------- */

const INSTRUCTIONS =
  'You are an image generation service. Call the image_generation tool exactly once with the user prompt as given; do not rewrite, expand, soften or discuss it. Pass the required size through unchanged — the caller sized it for a specific slot in a design. Reply with nothing else.'

/* gpt-image-2 on this path refuses `background: transparent` ("not supported
   for this model"), so cut-outs are not offered: a design places the image in
   a box or masks it with CSS. */
function requestBody(model: string, req: ImageRequest) {
  const size = SIZES[req.aspect ?? 'square']
  /* the fronting model chooses the tool's arguments itself and will pick a
     square for a mascot however the tool is configured, so the size is stated
     in the prompt as well as on the tool */
  const text = `${req.prompt}\n\nRequired size: ${size}`
  return {
    model,
    instructions: INSTRUCTIONS,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    tools: [
      {
        type: 'image_generation',
        model: IMAGE_MODEL,
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

function chatgptGenerator(account: ModelAccount): Generator {
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
        requestBody(ROUTER_MODEL || modelFor(live), req),
      )
    },
  }
}

function apiKeyGenerator(apiKey: string, label: string, model: string): Generator {
  return {
    ok: true,
    label,
    run: (req) =>
      generateViaResponses(OPENAI_URL, { Authorization: `Bearer ${apiKey}` }, label, requestBody(model, req)),
  }
}

const NO_GENERATOR =
  'image generation is not available: connect a ChatGPT subscription or OpenAI API key in Settings (or the server operator sets OPENAI_API_KEY). Meanwhile draw the visual as inline SVG/CSS or use search_images.'

/**
 * The generator for one payer: their own connected account first (their
 * subscription or key), else the server key, else nothing.
 */
export async function generatorFor(payerId?: string): Promise<Generator> {
  /* a lookup failure must not read as "no account": that would quietly move
     the charge from the user's own account onto the server key */
  const account = payerId
    ? await getAccount(payerId).catch((err) => {
        console.error('[image-gen] could not read the connected model account', err)
        throw new Error('could not read your connected model account — try again in a moment')
      })
    : null
  if (account?.kind === 'chatgpt') return chatgptGenerator(account)
  if (account?.kind === 'openai-key' && account.apiKey) {
    return apiKeyGenerator(account.apiKey, 'OpenAI', ROUTER_MODEL || modelFor(account))
  }
  const serverKey = process.env.OPENAI_API_KEY
  if (serverKey) return apiKeyGenerator(serverKey, 'server', ROUTER_MODEL || DEFAULT_OPENAI_MODEL)
  return { ok: false, reason: NO_GENERATOR }
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
    if (err instanceof ModelAuthError && generator.label === 'server') {
      throw new Error('OpenAI rejected this server’s OPENAI_API_KEY', { cause: err })
    }
    throw err
  }
}

/* exported for tests */
export const _internal = { requestBody, SIZES }
