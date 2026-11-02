/** The languages the interface is written in. The server validates its
 *  DEFAULT_LOCALE against this list; the client offers it in Settings. */
export const LOCALES = ['en', 'pt-BR'] as const
export type Locale = (typeof LOCALES)[number]

/** What everyone reads when neither they nor the server picked a language. */
export const FALLBACK_LOCALE: Locale = 'en'

/** Each language named in itself, the way a language menu lists it. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
}

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value)
}

/** GET /api/locale-config: the language this server shows to anyone who has
 *  not picked one. */
export interface LocaleConfig {
  defaultLocale: Locale
}
