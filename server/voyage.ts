/**
 * Voyage AI client for multimodal vector embeddings (voyage-multimodal-3).
 *
 * Powers vector similarity search for the background library. Voyage embeds
 * both image pixels and text into the same joint representation space so
 * queries match visually and semantically.
 *
 * Soft-fails on error or when VOYAGE_API_KEY is unset so the rest of the system
 * degrades gracefully to keyword search.
 */

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/multimodalembeddings'
const VOYAGE_MODEL = 'voyage-multimodal-3'
const FETCH_TIMEOUT_MS = 15_000

export function embeddingEnabled(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY)
}

function toDataUrl(buffer: Buffer): string {
  const base64 = buffer.toString('base64')
  if (buffer.length >= 4 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return `data:image/webp;base64,${base64}`
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return `data:image/png;base64,${base64}`
  }
  return `data:image/jpeg;base64,${base64}`
}

interface VoyageEmbeddingResponse {
  data?: Array<{
    embedding?: number[]
    index?: number
  }>
}

/**
 * Generate a vector embedding for an image buffer using Voyage's multimodal API.
 * Soft-fails (returns null) on error, timeout, or when VOYAGE_API_KEY is unset.
 */
export async function embedImage(imageBuffer: Buffer): Promise<number[] | null> {
  const key = process.env.VOYAGE_API_KEY
  if (!key) return null

  try {
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        inputs: [
          {
            content: [
              {
                type: 'image_base64',
                image_base64: toDataUrl(imageBuffer),
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!res.ok) {
      console.warn(`[voyage] image embedding failed: HTTP ${res.status}`)
      return null
    }

    const json = (await res.json()) as VoyageEmbeddingResponse
    const vector = json.data?.[0]?.embedding
    return Array.isArray(vector) ? vector : null
  } catch (e) {
    console.warn(`[voyage] image embedding failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

/**
 * Generate a vector embedding for a text string using Voyage's multimodal API.
 * Soft-fails (returns null) on error, timeout, or when VOYAGE_API_KEY is unset.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const key = process.env.VOYAGE_API_KEY
  if (!key) return null
  const trimmed = text.trim()
  if (!trimmed) return null

  try {
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        inputs: [
          {
            content: [
              {
                type: 'text',
                text: trimmed,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!res.ok) {
      console.warn(`[voyage] text embedding failed: HTTP ${res.status}`)
      return null
    }

    const json = (await res.json()) as VoyageEmbeddingResponse
    const vector = json.data?.[0]?.embedding
    return Array.isArray(vector) ? vector : null
  } catch (e) {
    console.warn(`[voyage] text embedding failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}
