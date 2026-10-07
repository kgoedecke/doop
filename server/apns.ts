import { connect } from 'node:http2'
import { createPrivateKey, sign } from 'node:crypto'

export function apnsConfigured() {
  return !!(process.env.DOOP_APNS_TEAM_ID && process.env.DOOP_APNS_KEY_ID && process.env.DOOP_APNS_PRIVATE_KEY)
}

let cached: { token: string; until: number } | undefined
function authorization() {
  if (cached && cached.until > Date.now()) return cached.token
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.DOOP_APNS_KEY_ID })).toString('base64url')
  const claims = Buffer.from(
    JSON.stringify({ iss: process.env.DOOP_APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }),
  ).toString('base64url')
  const input = `${header}.${claims}`
  const key = createPrivateKey((process.env.DOOP_APNS_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'))
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  cached = { token: `${input}.${signature}`, until: Date.now() + 40 * 60_000 }
  return cached.token
}

/** Fixed Apple endpoints only; neither token registrations nor callbacks choose a host/topic. */
export async function sendLiveActivityPush(
  token: string,
  environment: string,
  payload: object,
  priority: 5 | 10 = 5,
): Promise<number> {
  const jwt = authorization()
  const host = environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
  const body = JSON.stringify(payload)
  if (Buffer.byteLength(body) > 4096) throw new Error('Activity payload exceeds APNs limit')
  return new Promise((resolve, reject) => {
    const session = connect(host)
    const timer = setTimeout(() => {
      session.destroy()
      reject(new Error('APNs request timed out'))
    }, 10_000)
    session.on('error', (error) => {
      clearTimeout(timer)
      session.destroy()
      reject(error)
    })
    const request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': `${process.env.DOOP_APNS_BUNDLE_ID || 'design.doop.ios'}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': String(priority),
      'apns-expiration': '0',
    })
    let status = 0
    request.on('response', (headers) => {
      status = Number(headers[':status'])
    })
    request.on('data', () => {}) // drain without logging secrets or task content
    request.on('end', () => {
      clearTimeout(timer)
      session.close()
      resolve(status)
    })
    request.on('error', (error) => {
      clearTimeout(timer)
      session.destroy()
      reject(error)
    })
    request.end(body)
  })
}
