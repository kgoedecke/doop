import { afterEach, beforeEach, expect, it } from 'vitest'

/* Reads work but writes throw: a full localStorage, or a browser that hands
   out a zero quota. One session must still keep one identity. */
const data = new Map<string, string>()
let writable = true
const flaky: Storage = {
  get length() {
    return data.size
  },
  clear: () => data.clear(),
  getItem: (key) => data.get(key) ?? null,
  key: (index) => [...data.keys()][index] ?? null,
  removeItem: (key) => void data.delete(key),
  setItem: (key, value) => {
    if (!writable) throw new DOMException('quota exceeded', 'QuotaExceededError')
    data.set(key, String(value))
  },
}
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

beforeEach(() => {
  data.clear()
  Object.defineProperty(globalThis, 'localStorage', { value: flaky, configurable: true, writable: true })
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
})

it('keeps one identity per session when localStorage reads work but writes throw', async () => {
  writable = false
  const { getIdentity, setName } = await import('../src/lib/identity.ts')
  const first = getIdentity()
  expect(getIdentity()).toEqual(first)
  expect(data.size).toBe(0)

  setName('Quiet Otter')
  expect(getIdentity()).toEqual({ clientId: first.clientId, name: 'Quiet Otter' })

  /* once writes work again the stored value, not the stale memory, is read */
  writable = true
  setName('Loud Otter')
  expect(data.get('doop:name')).toBe('Loud Otter')
  data.set('doop:name', 'Renamed Elsewhere')
  expect(getIdentity().name).toBe('Renamed Elsewhere')
})
