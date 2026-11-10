import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createServer, request } from 'node:http'

const exec = promisify(execFile)
const script = path.resolve('scripts/private-storage-fixture.py')

/** Actual private bucket plus an IO counter, without replacing the application's S3 implementation. */
export async function startPrivateStorageFixture() {
  const parent = await mkdtemp(path.join(path.dirname(process.cwd()), 'doop-private-storage-'))
  const runtime = path.join(parent, 'runtime')
  const counts: Record<string, number> = {}
  const proxy = createServer()
  let listening = false
  const close = async () => {
    let proxyFailed = false
    try {
      if (listening)
        await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())))
    } catch {
      proxyFailed = true
    }
    listening = proxy.listening
    const hasState = await access(path.join(runtime, 'state.json')).then(
      () => true,
      () => false,
    )
    if (!hasState) throw new Error(`Private S3 ownership state is unavailable; runtime retained at ${runtime}`)
    try {
      if (hasState) await exec('python3', [script, 'stop', '--runtime-dir', runtime], { timeout: 60_000 })
    } catch {
      // Keep protected ownership metadata when Docker cannot complete cleanup.
      throw new Error(`Owned private S3 cleanup failed; runtime retained at ${runtime}`)
    }
    await rm(parent, { recursive: true, force: true })
    if (proxyFailed) throw new Error('Private storage fixture proxy could not close')
  }
  try {
    await exec('python3', [script, 'start', '--runtime-dir', runtime], { timeout: 120_000, maxBuffer: 8192 })
    const sdk = JSON.parse(await readFile(path.join(runtime, 'sdk.json'), 'utf8')) as {
      endpoint: string
      bucket: string
      key: string
      secret: string
    }
    proxy.on('request', (incoming, outgoing) => {
      const method = incoming.method ?? 'GET'
      counts[method] = (counts[method] ?? 0) + 1
      const upstream = request(
        new URL(incoming.url ?? '/', sdk.endpoint),
        { method, headers: incoming.headers, timeout: 30_000 },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(outgoing)
        },
      )
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502)
        outgoing.end()
      })
      upstream.on('timeout', () => upstream.destroy())
      incoming.pipe(upstream)
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    listening = true
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('fixture proxy did not bind')
    return {
      endpoint: sdk.endpoint,
      bucket: sdk.bucket,
      sdk: {
        region: 'garage',
        endpoint: sdk.endpoint,
        credentials: { accessKeyId: sdk.key, secretAccessKey: sdk.secret },
      },
      env: {
        BUCKET: sdk.bucket,
        REGION: 'garage',
        ENDPOINT: `http://127.0.0.1:${address.port}`,
        ACCESS_KEY_ID: sdk.key,
        SECRET_ACCESS_KEY: sdk.secret,
      },
      counts,
      resetCounts: () => {
        for (const key of Object.keys(counts)) delete counts[key]
      },
      close,
    }
  } catch {
    await close()
    throw new Error(
      'Private S3 fixture requires Docker, Python3, the pinned Garage image and a Docker-shared checkout parent; setup failed',
    )
  }
}
