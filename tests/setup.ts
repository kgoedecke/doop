/* Node 22+ defines a `localStorage` global that stays undefined unless the
   process starts with --localstorage-file, and happy-dom does not replace it.
   Give browser modules a working in-memory Storage so they behave as in a
   browser; each test file gets a fresh one. */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (typeof (globalThis as Record<string, unknown>)[name]?.constructor !== 'function') {
    Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true, writable: true })
  }
}
