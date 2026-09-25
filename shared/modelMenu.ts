/**
 * Curated model menus for the BYO providers, shared by server and client the
 * same way CLAUDE_MODELS is (shared/localAgent.ts). Hand-picked rather than
 * fetched from provider catalogs: every entry here has been judged fit for
 * design work, and the `vision` flag is what gates degraded no-screenshot
 * runs, so it must be deliberate, not scraped.
 */

export interface ModelOption {
  id: string
  name: string
  blurb: string
  /** false = the model cannot see images: runs skip visual review entirely */
  vision: boolean
}

/**
 * The OpenRouter roster. Ids and image-input capability verified against
 * GET https://openrouter.ai/api/v1/models (input_modalities) — re-check both
 * when editing. Ordered best-first; text-only entries say so in the blurb
 * because the picker renders the same words the flag enforces.
 */
export const OPENROUTER_MODELS: ModelOption[] = [
  {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    blurb: 'Moonshot’s flagship — strong agentic design work.',
    vision: true,
  },
  {
    id: 'moonshotai/kimi-k2.6',
    name: 'Kimi K2.6',
    blurb: 'Open-weight all-rounder with solid tool use. A good default.',
    vision: true,
  },
  {
    id: 'moonshotai/kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    blurb: 'Coding specialist — precise HTML/CSS edits.',
    vision: true,
  },
  {
    id: 'qwen/qwen3.8-max-0902',
    name: 'Qwen3.8 Max',
    blurb: 'Alibaba’s flagship for demanding, multi-step tasks.',
    vision: true,
  },
  { id: 'qwen/qwen3.7-plus', name: 'Qwen3.7 Plus', blurb: 'Multimodal workhorse — fast and dependable.', vision: true },
  {
    id: 'google/gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    blurb: 'Google’s coding and agent workhorse.',
    vision: true,
  },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', blurb: 'Zhipu’s fast tier, with vision.', vision: true },
  {
    id: 'z-ai/glm-5.3',
    name: 'GLM-5.3',
    blurb: 'Zhipu’s flagship. Text-only: no visual review of frames.',
    vision: false,
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    blurb: 'Cheap and capable, with vision.',
    vision: true,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    blurb: 'DeepSeek’s strongest. Text-only: no visual review of frames.',
    vision: false,
  },
  { id: 'minimax/minimax-m3', name: 'MiniMax M3', blurb: 'Multimodal agent model from MiniMax.', vision: true },
  { id: 'xiaomi/mimo-v2.6-pro', name: 'MiMo V2.6 Pro', blurb: 'Xiaomi’s multimodal pro tier.', vision: true },
]

export const DEFAULT_OPENROUTER_MODEL = 'moonshotai/kimi-k2.6'

/** Gemini direct (Google AI Studio API key). */
export const GEMINI_MODELS: ModelOption[] = [
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    blurb: 'Google’s reasoning flagship — the most thorough.',
    vision: true,
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    blurb: 'The everyday workhorse. A good default for design work.',
    vision: true,
  },
]

export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash'

/**
 * The image-model registry. `provider` names the credential family that can
 * run it — imageGen resolves a generator per provider (user account first,
 * then a server key). Adding a model later is one entry here, plus a new
 * generator in server/imageGen.ts only if it introduces a new provider.
 */
export type ImageProvider = 'openai' | 'gemini' | 'ark'

export interface ImageModelOption {
  id: string
  name: string
  blurb: string
  provider: ImageProvider
}

export const IMAGE_MODELS: ImageModelOption[] = [
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    blurb: 'OpenAI’s image model — reliable text rendering and UI assets.',
    provider: 'openai',
  },
  {
    id: 'gemini-3.1-flash-image',
    name: 'Nano Banana 2',
    blurb: 'Google’s image model — photoreal scenes, editing, 4K.',
    provider: 'gemini',
  },
  {
    id: 'seedream-5-0-pro',
    name: 'Seedream 5 Pro',
    blurb: 'ByteDance’s top image model — rich, painterly quality.',
    provider: 'ark',
  },
  { id: 'seedream-5-0-lite', name: 'Seedream 5 Lite', blurb: 'Faster, cheaper Seedream tier.', provider: 'ark' },
]

/** One place for "what do we call this account kind" — Settings, meter lines. */
export const ACCOUNT_KIND_LABELS = {
  chatgpt: 'ChatGPT',
  'openai-key': 'OpenAI',
  'anthropic-key': 'Claude API',
  'openrouter-key': 'OpenRouter',
  'gemini-key': 'Gemini',
} as const

export type AccountKindName = keyof typeof ACCOUNT_KIND_LABELS
