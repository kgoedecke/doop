import { createHash } from 'node:crypto'
import type { IconifyIcon } from '@iconify/types'
import { getIconData, quicklyValidateIconSet } from '@iconify/utils'
import { fetchPinnedPublicUrl } from './publicUrl.ts'
import * as storage from './storage.ts'

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_BATCH_URL = 500
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_ICON_BYTES = 256_000
const MAX_MEMORY_BYTES = 4_000_000
const MAX_QUEUED_ICONS = 2048
const DOWNLOAD_CONCURRENCY = 2

export function validIconId(id: string): boolean {
  return id.length <= 200 && ICON_NAME.test(id)
}

export class IconUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfter = 5,
  ) {
    super(message)
    this.name = 'IconUnavailableError'
  }
}

export class IconNotFoundError extends Error {}

interface PendingIcon {
  name: string
  resolve: (icon: IconifyIcon) => void
  reject: (error: unknown) => void
}

/** One immutable base icon per id, shared across users and color/size variants.
 * A short collection window batches simultaneous cold misses by icon set.
 * The queue bounds work, not the number of icons a page may render. */
export class IconDataStore {
  private memory = new Map<string, { icon: IconifyIcon; bytes: number }>()
  private memoryBytes = 0
  private inflight = new Map<string, Promise<IconifyIcon>>()
  private pending = new Map<string, PendingIcon[]>()
  private active = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private blockedUntil = 0

  async get(id: string): Promise<IconifyIcon> {
    if (!validIconId(id)) throw new Error('invalid Iconify icon id')
    const cached = this.memory.get(id)
    if (cached) {
      this.memory.delete(id)
      this.memory.set(id, cached)
      return { ...cached.icon }
    }
    const pending = this.inflight.get(id)
    if (pending) return { ...(await pending) }
    if (this.inflight.size >= MAX_QUEUED_ICONS) throw new IconUnavailableError('icon download queue is full')
    const task = this.load(id).finally(() => this.inflight.delete(id))
    this.inflight.set(id, task)
    return { ...(await task) }
  }

  private async load(id: string): Promise<IconifyIcon> {
    const key = `icons/v1-${createHash('sha256').update(id).digest('hex')}.json`
    const saved = await storage.getObject(key)
    if (saved) {
      const icon = JSON.parse(saved.toString('utf8')) as IconifyIcon
      this.remember(id, icon, saved.length)
      return icon
    }
    this.checkBackoff()
    const [prefix = '', name = ''] = id.split(':')
    const icon = await new Promise<IconifyIcon>((resolve, reject) => {
      const group = this.pending.get(prefix) ?? []
      group.push({ name, resolve, reject })
      this.pending.set(prefix, group)
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          this.pump()
        }, 20)
      }
    })
    const bytes = Buffer.from(JSON.stringify(icon))
    if (bytes.length > MAX_ICON_BYTES) throw new Error('icon data is too large')
    await storage.putObject(key, bytes, 'application/json')
    this.remember(id, icon, bytes.length)
    return icon
  }

  private remember(id: string, icon: IconifyIcon, bytes: number): void {
    this.memoryBytes += bytes
    this.memory.set(id, { icon: Object.freeze({ ...icon }), bytes })
    while (this.memoryBytes > MAX_MEMORY_BYTES) {
      const oldest = this.memory.entries().next().value
      if (!oldest) break
      this.memory.delete(oldest[0])
      this.memoryBytes -= oldest[1].bytes
    }
  }

  private checkBackoff(): void {
    const seconds = Math.ceil((this.blockedUntil - Date.now()) / 1000)
    if (seconds > 0) throw new IconUnavailableError(`Iconify is rate limited; retry in ${seconds} seconds`, seconds)
  }

  private pump(): void {
    try {
      this.checkBackoff()
    } catch (error) {
      for (const group of this.pending.values()) for (const entry of group) entry.reject(error)
      this.pending.clear()
      return
    }
    while (this.active < DOWNLOAD_CONCURRENCY && this.pending.size > 0) {
      const [prefix, group] = this.pending.entries().next().value!
      group.sort((a, b) => a.name.localeCompare(b.name))
      const entries: PendingIcon[] = []
      let url = ''
      while (group.length > 0) {
        const names = [...entries.map((entry) => entry.name), group[0]!.name].join(',')
        const nextUrl = `https://api.iconify.design/${prefix}.json?icons=${names}`
        if (entries.length && nextUrl.length > MAX_BATCH_URL) break
        url = nextUrl
        entries.push(group.shift()!)
      }
      if (!group.length) this.pending.delete(prefix)
      this.active++
      void this.download(prefix, url, entries).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async download(prefix: string, url: string, entries: PendingIcon[]): Promise<void> {
    try {
      const response = await fetchPinnedPublicUrl(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      })
      if (response.status === 429) {
        const retry = response.headers.get('retry-after')
        const seconds =
          retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : NaN
        const wait = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60
        this.blockedUntil = Math.max(this.blockedUntil, Date.now() + wait * 1000)
        await response.body?.cancel()
        this.checkBackoff()
      }
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 404) throw new IconNotFoundError(`icon set ${prefix} not found`)
        throw new IconUnavailableError(`icon data fetch failed: HTTP ${response.status}`)
      }
      const data = quicklyValidateIconSet(JSON.parse((await readIconResponse(response)).toString('utf8')))
      if (!data || data.prefix !== prefix) throw new Error('invalid icon data response')
      for (const entry of entries) {
        const exists = Object.hasOwn(data.icons, entry.name) || Object.hasOwn(data.aliases ?? {}, entry.name)
        const icon = exists ? getIconData(data, entry.name) : null
        if (icon) entry.resolve(icon)
        else entry.reject(new IconNotFoundError(`icon ${prefix}:${entry.name} not found`))
      }
    } catch (error) {
      for (const entry of entries) entry.reject(error)
    }
  }
}

async function readIconResponse(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty icon data response')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('icon data response is too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

export const iconData = new IconDataStore()
