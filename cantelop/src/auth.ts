import type { ApiEnvironment } from '@cantelop/sdk/api'
import { ApiError } from './validation.js'
const encoder = new TextEncoder()
function decode(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid base64url')
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}
// Verify an externally issued application identity. Only the public key enters
// Cantelop: a compromised native agent must not be able to mint tenant tokens.
export async function identity(request: Request, env: ApiEnvironment) {
  if (!env.AUTH_PUBLIC_JWK || !env.AUTH_ISSUER || !env.AUTH_AUDIENCE)
    throw new ApiError(503, 'Application identity is not configured')
  try {
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token || token.length > 8192) throw new Error()
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error()
    const [head, body, signature] = parts as [string, string, string]
    const header = JSON.parse(new TextDecoder().decode(decode(head)))
    const claims = JSON.parse(new TextDecoder().decode(decode(body)))
    if (header.alg !== 'ES256' || header.crit !== undefined) throw new Error()
    const jwk = JSON.parse(env.AUTH_PUBLIC_JWK) as JsonWebKey
    if (jwk.d || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error()
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        decode(signature),
        encoder.encode(`${head}.${body}`),
      ))
    )
      throw new Error()
    const now = Date.now() / 1000
    if (
      claims.iss !== env.AUTH_ISSUER ||
      claims.aud !== env.AUTH_AUDIENCE ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      claims.sub.length > 128 ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))
    )
      throw new Error()
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([claims.iss, claims.sub]))),
    )
    const userId = Array.from(hash.slice(0, 24), (b) => b.toString(16).padStart(2, '0')).join('')
    return { userId, workspaceSlug: `u-${userId}` }
  } catch {
    throw new ApiError(401, 'Valid application bearer token required')
  }
}
