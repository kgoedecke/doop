// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/lib/i18n/en'
import { ptBR } from '../src/lib/i18n/pt-BR'
import type { Catalog, MessageKey } from '../src/lib/i18n'

/* the test runtime has no localStorage; the module only needs get and set */
const store = new Map<string, string>()
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
}

/* the module caches the language, so every test gets a fresh copy */
type I18nModule = typeof import('../src/lib/i18n')
let i18n: I18nModule

function serverSays(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  )
}

beforeEach(async () => {
  store.clear()
  vi.stubGlobal('localStorage', storage)
  document.documentElement.lang = ''
  vi.resetModules()
  i18n = await import('../src/lib/i18n')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Message = string | { one: string; other: string }

function entries(catalog: Catalog): [string, Message][] {
  return Object.entries(catalog).flatMap(([namespace, messages]) =>
    Object.entries(messages as Record<string, Message>).map(([key, message]): [string, Message] => [
      `${namespace}.${key}`,
      message,
    ]),
  )
}

function placeholders(message: Message): string[] {
  const text = typeof message === 'string' ? message : `${message.one} ${message.other}`
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ''))].sort()
}

describe('catalogs', () => {
  /* the type already demands every key; this catches what it cannot see */
  it('gives pt-BR the same keys, the same plural shape and the same placeholders as English', () => {
    const translated = new Map(entries(ptBR))
    for (const [key, source] of entries(en)) {
      const message = translated.get(key)
      expect(message, key).toBeDefined()
      expect(typeof message, key).toBe(typeof source)
      expect(placeholders(message!), key).toEqual(placeholders(source))
    }
    expect(translated.size).toBe(entries(en).length)
  })
})

describe('translateIn', () => {
  it('fills placeholders and picks the plural form for the count', () => {
    expect(i18n.translateIn('en', 'settings.meterLeft', { left: 2, count: 5 })).toBe('2 of 5 free tasks left.')
    expect(i18n.translateIn('en', 'settings.meterLeft', { left: 1, count: 1 })).toBe('1 of 1 free task left.')
    expect(i18n.translateIn('pt-BR', 'settings.meterLeft', { left: 1, count: 1 })).toBe(
      '1 de 1 tarefa gratuita restante.',
    )
  })

  it('falls back to English, then to the key, instead of rendering a blank', () => {
    const missing = 'settings.notThere' as MessageKey
    expect(i18n.translateIn('pt-BR', missing)).toBe('settings.notThere')
  })
})

describe('locale', () => {
  it("uses the server's default until this browser picks a language", async () => {
    serverSays({ defaultLocale: 'pt-BR' })
    await i18n.initLocale()
    expect(i18n.getLocale()).toBe('pt-BR')
    expect(document.documentElement.lang).toBe('pt-BR')
    expect(i18n.t('shell.logOut')).toBe('Sair')

    i18n.setLocale('en')
    expect(i18n.getLocale()).toBe('en')
    expect(store.get('doop-locale')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('does not ask the server when the browser already picked', async () => {
    store.set('doop-locale', 'pt-BR')
    serverSays({ defaultLocale: 'en' })
    await i18n.initLocale()
    expect(fetch).not.toHaveBeenCalled()
    expect(i18n.getLocale()).toBe('pt-BR')
  })

  it('falls back to English when the server is unreachable or answers nonsense', async () => {
    serverSays({ defaultLocale: 'klingon' })
    await i18n.initLocale()
    expect(i18n.getLocale()).toBe('en')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    await i18n.initLocale()
    expect(i18n.getLocale()).toBe('en')
  })
})
